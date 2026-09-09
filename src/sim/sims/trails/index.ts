/**
 * Afterglow.
 *
 * Pure black. A present hand leaves trails of light that linger and slowly
 * fade; with nobody there the picture returns to true black. Drawing with a
 * slow luminous brush in a dark room: calm, high dynamic range, never garish.
 *
 * The strokes are laid down where the hand is IN the volume: each segment has
 * 3D endpoints in world units and is projected through the shared window
 * camera onto the glass before it is deposited, so a stroke deeper in is
 * smaller, drawn toward the centre, dimmer and a touch cooler (aerial
 * perspective), and a soft pool of light on the floor beneath it, rising
 * toward the horizon with depth, makes the position readable. Sparkles live
 * in the volume too and are projected by the same camera in their vertex
 * shader.
 *
 * Pipeline per display frame (all GPU work happens in `render`; `step` is
 * CPU-only and deterministic):
 *   0. probe collect — drain any 16×16 probe readbacks whose fence has
 *                      signalled (queued a frame or two ago) into signals.
 *   1. accumulate    — full-res: old × decay − floor, plus this frame's stroke
 *                      segments (distance-to-segment brush, saturating deposit)
 *                      and their floor pools in the alpha channel.
 *   2. bloom         — quarter-res prefilter, separable blur (3 small passes).
 *   3. composite     — full-res: exposure, bloom, floor pool gated by presence,
 *                      ACES tone-map, gamma, grain, then sparkles as additive
 *                      point sprites on top.
 *   4. probe queue   — 16×16 reduction of the accumulation, read into a fresh
 *                      pixel-pack buffer behind a fence; never waited on.
 * Two full-res passes plus small ones; `low` quality halves the buffers.
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { approach, clamp01 } from '../../core/math';
import { windowCamera } from '../../core/camera';
import { Noise } from '../../core/noise';
import { Fbo, PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { Program } from '../../gl/program';
import { blit, drawQuad, quadProgram } from '../../gl/quad';
import { BLUR_FS, COMPOSITE_FS, DOWNSAMPLE_FS, POINTS_FS, POINTS_VS, PROBE_FS, accumulateShader } from './shaders';
import {
  HEAD_K, InkDepth, SparkleField, StrokeTracker, decayFor, depthAttenuation, floorColour, floorFor, hueWander, inkTarget, projectFloorPool, projectSegment,
  reduceProbe, sparkColour, sparkleRate, type StrokeSegment,
} from './logic';

const MAX_SEGMENTS = 32;
const PROBE_SIZE = 16;
/** Normalised accumulation → HDR before tone-mapping: 1.0 stored reads as a warm white. */
const EXPOSURE = 3;
/** HDR level above which light feeds the bloom. */
const BLOOM_THRESHOLD = .12;
/** Displayed luminance above which a probe tap counts as "lit". */
const COVERAGE_THRESHOLD = .06;
/** Peak display brightness of a sparkle. */
const SPARK_GAIN = .9;
/** Display gain of the floor pool at `floor` = 1 and full presence. */
const POOL_DISPLAY = .3;
/** Probe readbacks allowed in flight at once; a fourth frame simply skips the probe. */
const MAX_IN_FLIGHT = 3;
/** Seconds after which the grain seed wraps: the composite hashes `u_time` in fp32, which loses the fractional bits a many-hour run needs. */
const GRAIN_PERIOD = 100;

export default defineSimulation({
  id: 'trails',
  title: 'Afterglow',
  description: 'Black; a present hand leaves slowly fading trails of light in the volume, like drawing with a slow luminous brush in a dark room.',
  params: {
    lifetime: { kind: 'number', default: 4, min: .3, max: 20, step: .1, unit: 's', label: 'Lifetime', description: 'Seconds a fresh stroke takes to fade back to black.' },
    brushSize: { kind: 'number', default: .065, min: .01, max: .2, step: .005, label: 'Brush size', description: 'Brush radius in uniform units (canvas height = 1) for a typical hand at the glass; scales with the hand blob and a little with speed, and shrinks with perspective deeper in (about 0.05 mid-volume).' },
    brightness: { kind: 'number', default: 1, min: 0, max: 3, step: .05, label: 'Brightness', description: 'How much light each stroke deposits. Overlapping strokes bloom toward white.' },
    hue: { kind: 'number', default: .055, min: 0, max: 1, step: .005, label: 'Hue', description: 'Base hue of the light: 0 red, 0.33 green, 0.66 blue.' },
    hueDrift: { kind: 'number', default: .02, min: 0, max: .2, step: .001, unit: 'Hz', label: 'Hue drift', description: 'How fast the hue wanders (at most ±0.08 around the base hue, so the palette stays coherent).' },
    saturation: { kind: 'number', default: .55, min: 0, max: 1, step: .01, label: 'Saturation', description: 'Colour saturation of the stroke edges; the core always reads warm-white.' },
    depthFade: { kind: 'number', default: .6, min: 0, max: 1, step: .01, label: 'Depth fade', description: 'Aerial perspective: how much strokes laid down deeper in the volume dim and cool (perspective already makes them smaller and draws them toward the centre). Also fogs deep sparkles.' },
    floor: { kind: 'number', default: .8, min: 0, max: 2, step: .05, label: 'Floor light', description: 'Brightness of the soft pool of light a stroke casts on the floor of the volume, the depth cue; fades with presence.' },
    sparkle: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Sparkle', description: 'Amount of sparkles shed along the stroke.' },
    drift: { kind: 'number', default: .4, min: 0, max: 1, step: .01, label: 'Drift', description: 'Wind strength on the sparkles (curl noise).' },
    bloom: { kind: 'number', default: .6, min: 0, max: 2, step: .01, label: 'Bloom', description: 'Glow spread around bright light.' },
    grain: { kind: 'number', default: .25, min: 0, max: 1, step: .01, label: 'Grain', description: 'Subtle film grain in lit areas.' },
  },
  signals: {
    glow: { min: 0, max: 1, description: 'Mean displayed luminance of the strokes, from a 16×16 probe of the accumulation (the floor pool is not counted).', smoothing: .1 },
    ink: { min: 0, max: 1, description: 'Recent stroke energy: how much light the hands are laying down right now, smoothed.', smoothing: .1 },
    hue: { min: 0, max: 1, description: 'Current hue after the wander.' },
    coverage: { min: 0, max: 1, description: 'Fraction of the picture that is lit (probe taps above a small luminance threshold).', smoothing: .1 },
    sparkles: { min: 0, max: 1, description: 'Fraction of the sparkle budget currently alive.' },
    depth: { min: 0, max: 1, description: 'Energy-weighted mean depth of the ink laid down recently: 0 at the glass, 1 at the back wall; 0 when nothing recent.', smoothing: .1 },
  },
  create(ctx) {
    const gl = ctx.gl;
    const format = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    const hdr = format !== 'rgba8';
    const scale = ctx.quality === 'low' ? .5 : 1;
    const capacity = ctx.quality === 'low' ? 600 : ctx.quality === 'medium' ? 1400 : 2000;
    const depth = ctx.depth, invDepth = 1 / Math.max(depth, 1e-6);

    const accumulate = quadProgram(gl, accumulateShader(MAX_SEGMENTS), 'afterglow-accumulate');
    const downsample = quadProgram(gl, DOWNSAMPLE_FS, 'afterglow-downsample');
    const blur = quadProgram(gl, BLUR_FS, 'afterglow-blur');
    const composite = quadProgram(gl, COMPOSITE_FS, 'afterglow-composite');
    const probeProgram = quadProgram(gl, PROBE_FS, 'afterglow-probe');
    const points = new Program(gl, POINTS_VS, POINTS_FS, 'afterglow-sparkles');

    // --- render targets -------------------------------------------------
    let aspect = ctx.aspect;
    let camera = windowCamera(aspect, depth);
    let accum!: PingPong, bloomA!: Fbo, bloomB!: Fbo;
    const probe = new Fbo(gl, PROBE_SIZE, PROBE_SIZE, 'rgba8', 'nearest');
    // Async probe readback: each frame's probe is read into a fresh 1 KB pixel-pack buffer
    // behind a fence and collected once the fence has signalled, so the CPU never waits on
    // the GPU for signals (a synchronous readPixels would drain the whole queue every frame).
    // A buffer is never rewritten after being fenced: Chrome keeps a shadow copy per fenced
    // READ-usage buffer and warns when one is overwritten before it is consumed.
    const probePixels = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    const inFlight: { buffer: WebGLBuffer; fence: WebGLSync }[] = []; // oldest first
    function allocate(width: number, height: number, previous?: PingPong) {
      const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
      accum = new PingPong(gl, w, h, format, 'linear'); accum.clear();
      bloomA = new Fbo(gl, Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)), format, 'linear'); bloomA.clear();
      bloomB = new Fbo(gl, bloomA.width, bloomA.height, format, 'linear'); bloomB.clear();
      if (previous) { accum.write.bind(); blit(gl, previous.read.texture); accum.swap(); }
    }
    allocate(ctx.width, ctx.height);

    // --- sparkle geometry: world position, size, colour -------------------
    const FLOATS_PER_SPARK = 7;
    const vao = gl.createVertexArray(), vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Could not create sparkle buffers.');
    const vertexData = new Float32Array(capacity * FLOATS_PER_SPARK);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_SPARK * 4;
    const aPos = points.attribute('a_pos'), aSize = points.attribute('a_size'), aCol = points.attribute('a_col');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aSize); gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, stride, 16);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // --- CPU state ------------------------------------------------------
    const strokes = new StrokeTracker();
    const sparkles = new SparkleField(capacity);
    const inkDepth = new InkDepth();
    const hueNoise = new Noise(11);
    const pending: StrokeSegment[] = [];
    const segPos = new Float32Array(MAX_SEGMENTS * 4), segCol = new Float32Array(MAX_SEGMENTS * 4), segPool = new Float32Array(MAX_SEGMENTS * 4);
    let pendingDt = 0, time = 0, hue = 0, ink = 0, glow = 0, coverage = 0, presence = 0;

    return {
      step(input: SimInput, params) {
        time = input.time; presence = input.presence;
        hue = hueWander(params.hue, time, params.hueDrift, hueNoise);
        const segments = strokes.update(input.hands, aspect, depth, input.dt, { brushSize: params.brushSize, brightness: params.brightness, saturation: params.saturation, hue, depthFade: params.depthFade });
        let energy = 0;
        for (const s of segments) {
          if (pending.length >= MAX_SEGMENTS) pending.shift();
          pending.push(s);
          energy += s.amplitude;
          if (params.sparkle > 0) sparkles.emit(s, params.sparkle * sparkleRate(s.length, s.radius, input.dt), sparkColour(s.r, s.g, s.b));
        }
        ink = approach(ink, inkTarget(energy, input.dt), input.dt, energy > 0 ? .1 : .3);
        inkDepth.update(segments, input.dt);
        sparkles.step(input.dt, time, params.drift, aspect, depth);
        pendingDt += input.dt;
      },

      render(frame, params) {
        // 0. Collect finished probe readbacks, oldest first; the newest wins. Stop at the first
        //    fence still pending (later ones cannot have signalled before it).
        while (inFlight.length) {
          const { buffer, fence } = inFlight[0];
          const status = gl.clientWaitSync(fence, 0, 0);
          if (status === gl.TIMEOUT_EXPIRED) break;
          inFlight.shift();
          if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, probePixels);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            const reduced = reduceProbe(probePixels, PROBE_SIZE * PROBE_SIZE);
            glow = reduced.glow; coverage = reduced.coverage;
          }
          gl.deleteSync(fence); gl.deleteBuffer(buffer);
        }
        const elapsed = pendingDt;
        if (elapsed > 0 || pending.length) {
          // 1. Decay, then deposit this frame's segments projected onto the glass, and their floor pools.
          const count = Math.min(MAX_SEGMENTS, pending.length);
          for (let i = 0; i < count; i++) {
            const s = pending[i], p = projectSegment(s, camera), pool = projectFloorPool(s, camera);
            segPos[i * 4] = p.ax; segPos[i * 4 + 1] = p.ay; segPos[i * 4 + 2] = p.bx; segPos[i * 4 + 3] = p.by;
            segCol[i * 4] = s.r * s.amplitude; segCol[i * 4 + 1] = s.g * s.amplitude; segCol[i * 4 + 2] = s.b * s.amplitude; segCol[i * 4 + 3] = p.radius;
            segPool[i * 4] = pool.x; segPool[i * 4 + 1] = pool.y; segPool[i * 4 + 2] = pool.rx; segPool[i * 4 + 3] = s.amplitude * pool.gain;
          }
          accum.write.bind();
          accumulate.use().texture('u_prev', accum.read.texture, 0)
            .f1('u_decay', decayFor(elapsed, params.lifetime)).f1('u_floor', floorFor(params.lifetime, hdr) * elapsed)
            .f1('u_aspect', aspect).f1('u_headK', HEAD_K).f1('u_eye', camera.eye).i1('u_count', count)
            .f4v('u_segPos', segPos).f4v('u_segCol', segCol).f4v('u_segPool', segPool);
          drawQuad(gl);
          accum.swap(); pendingDt = 0; pending.length = 0;
          // 2. Bloom at quarter resolution.
          bloomA.bind();
          downsample.use().texture('u_src', accum.read.texture, 0).f2('u_texel', 1 / accum.width, 1 / accum.height).f1('u_exposure', EXPOSURE).f1('u_threshold', BLOOM_THRESHOLD);
          drawQuad(gl);
          bloomB.bind(); blur.use().texture('u_src', bloomA.texture, 0).f2('u_dir', 1 / bloomA.width, 0); drawQuad(gl);
          bloomA.bind(); blur.use().texture('u_src', bloomB.texture, 0).f2('u_dir', 0, 1 / bloomA.height); drawQuad(gl);
        }
        // 3. Composite to the screen, then sparkles on top.
        bindScreen(gl, frame.width, frame.height);
        const [pr, pg, pb] = floorColour(hue, params.saturation);
        composite.use().texture('u_accum', accum.read.texture, 0).texture('u_bloom', bloomA.texture, 1)
          .f1('u_exposure', EXPOSURE).f1('u_bloomAmount', params.bloom).f1('u_grain', params.grain).f1('u_time', frame.time % GRAIN_PERIOD)
          .f1('u_pool', POOL_DISPLAY * params.floor * presence).f3('u_poolColor', pr, pg, pb);
        drawQuad(gl);
        if (sparkles.count > 0) {
          const gain = SPARK_GAIN * clamp01(params.brightness);
          let k = 0;
          for (let i = 0; i < sparkles.count; i++) {
            const z = sparkles.z[i];
            const intensity = sparkles.intensity(i, time) * gain * depthAttenuation(z * invDepth, params.depthFade);
            vertexData[k++] = sparkles.x[i]; vertexData[k++] = sparkles.y[i]; vertexData[k++] = z; vertexData[k++] = sparkles.size[i];
            vertexData[k++] = sparkles.r[i] * intensity; vertexData[k++] = sparkles.g[i] * intensity; vertexData[k++] = sparkles.b[i] * intensity;
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData, 0, k); gl.bindBuffer(gl.ARRAY_BUFFER, null);
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
          points.use().matrix4('u_matrix', camera.matrix).f1('u_eye', camera.eye).f1('u_pointScale', frame.height / 900);
          gl.bindVertexArray(vao); gl.drawArrays(gl.POINTS, 0, sparkles.count); gl.bindVertexArray(null);
          gl.disable(gl.BLEND);
        }
        // 4. Queue a probe readback for a later frame's signals, if a slot is free.
        if (inFlight.length < MAX_IN_FLIGHT) {
          const buffer = gl.createBuffer();
          if (buffer) {
            probe.bind();
            probeProgram.use().texture('u_src', accum.read.texture, 0).f1('u_exposure', EXPOSURE).f1('u_threshold', COVERAGE_THRESHOLD).f1('u_cell', 1 / PROBE_SIZE);
            drawQuad(gl);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.bufferData(gl.PIXEL_PACK_BUFFER, probePixels.byteLength, gl.STREAM_READ);
            gl.readPixels(0, 0, PROBE_SIZE, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (fence) inFlight.push({ buffer, fence }); else gl.deleteBuffer(buffer);
            gl.flush();
          }
        }
        bindScreen(gl, frame.width, frame.height);
      },

      signals() {
        return { glow: clamp01(glow), ink: clamp01(ink), hue: clamp01(hue), coverage: clamp01(coverage), sparkles: sparkles.alive, depth: inkDepth.value };
      },

      resize(width, height) {
        aspect = width / Math.max(1, height);
        camera = windowCamera(aspect, depth);
        const old = accum, oldA = bloomA, oldB = bloomB;
        allocate(width, height, old);
        old.dispose(); oldA.dispose(); oldB.dispose();
        strokes.reset(); pending.length = 0;
      },

      dispose() {
        for (const { buffer, fence } of inFlight) { gl.deleteSync(fence); gl.deleteBuffer(buffer); }
        inFlight.length = 0;
        accumulate.dispose(); downsample.dispose(); blur.dispose(); composite.dispose(); probeProgram.dispose(); points.dispose();
        accum.dispose(); bloomA.dispose(); bloomB.dispose(); probe.dispose();
        gl.deleteVertexArray(vao); gl.deleteBuffer(vbo);
      },
    };
  },
});
