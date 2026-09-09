/**
 * Afterglow.
 *
 * Pure black. A present hand leaves trails of light that linger and slowly
 * fade; with nobody there the picture returns to true black. Drawing with a
 * slow luminous brush in a dark room: calm, high dynamic range, never garish.
 *
 * The whole body paints, at whatever fidelity the source knows it:
 *  - a depth-camera scan (`input.surface`) paints wherever the shell moved
 *    since the last step, each changed cell a dot at its 3D position, so a
 *    moving hand leaves a trail the shape of its silhouette and a still one
 *    leaves nothing;
 *  - a skeleton (`hand.capsules`) paints a stroke per capsule over the area
 *    it swept: fingertips leave thin bright lines, the palm a broad soft one,
 *    a fist one compact blob, and a full hand is normalised so it is not
 *    dozens of times brighter than the sphere it replaces;
 *  - a bare position paints with the single brush it always did.
 * Strokes are laid down where the body is IN the volume: every end is
 * projected through the shared window camera onto the glass before it is
 * deposited, so a stroke deeper in is smaller, drawn toward the centre, dimmer
 * and a touch cooler (aerial perspective), and a soft pool of light on the
 * floor beneath the hand makes its position readable. Sparkles are shed from
 * fingertips (or the scan's silhouette edge) and live in the volume too. A
 * very faint ghost of the solid itself shows the performer what is painting.
 *
 * Pipeline per display frame (all GPU work happens in `render`; `step` is
 * CPU-only and deterministic):
 *   0. probe collect — drain any 16×16 probe readbacks whose fence has
 *                      signalled (queued a frame or two ago) into signals.
 *   1. decay         — full-res: old × decay − floor.
 *   2. strokes       — instanced quads, additive: each sweep covers only its
 *                      projected extent plus the brush radius; the saturating
 *                      deposit reads the decayed previous frame. Then the
 *                      floor pools the same way into the alpha channel.
 *   3. bloom         — quarter-res prefilter, separable blur (3 small passes).
 *   4. composite     — full-res: exposure, bloom, floor pool gated by presence,
 *                      ACES tone-map, gamma, grain; then sparkles as additive
 *                      point sprites and the ghost as ray-marched quads.
 *   5. probe queue   — 16×16 reduction of the accumulation, read into a fresh
 *                      pixel-pack buffer behind a fence; never waited on.
 * Two full-res passes plus small ones; `low` quality halves the buffers.
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { approach, clamp01, hsv } from '../../core/math';
import { windowCamera } from '../../core/camera';
import { Noise } from '../../core/noise';
import { Fbo, PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { Program } from '../../gl/program';
import { blit, drawQuad, quadProgram } from '../../gl/quad';
import { MAX_HAND_BOUNDS, createPackedHands, packHands } from '../../gl/hand';
import { SurfaceTexture } from '../../gl/surface';
import { BLUR_FS, COMPOSITE_FS, DECAY_FS, DOWNSAMPLE_FS, GHOST_FS, GHOST_VS, POINTS_FS, POINTS_VS, POOL_FS, POOL_VS, PROBE_FS, STROKE_FS, STROKE_VS } from './shaders';
import {
  HEAD_K, InkDepth, SparkleField, StrokeTracker, SurfacePainter, createScanStrokes, decayFor, depthAttenuation, floorColour, floorFor, hueWander, inkTarget, paintingStrokes,
  projectFloorPool, projectSweep, reduceProbe, scanBounds, sparkColour, sparkleRate, type CapsuleStroke, type StrokeSegment,
} from './logic';

/** Sweeps drawn per frame at most (a scan can change a few hundred cells per step; several steps may share a frame). */
const MAX_STROKES = 1024;
/** Floor pools per frame at most: one per hand per step. */
const MAX_POOLS = 16;
const FLOATS_PER_STROKE = 12, FLOATS_PER_POOL = 4, FLOATS_PER_BOUND = 4;
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
  description: 'Black; a present hand leaves slowly fading trails of light in the volume, like drawing with a slow luminous brush in a dark room. A scanned or skeletal hand paints with its whole shape.',
  params: {
    lifetime: { kind: 'number', default: 4, min: .3, max: 20, step: .1, unit: 's', label: 'Lifetime', description: 'Seconds a fresh stroke takes to fade back to black.' },
    brushSize: { kind: 'number', default: .065, min: .01, max: .2, step: .005, label: 'Brush size', description: 'Brush radius in uniform units (canvas height = 1) for a bare hand position at the glass; scales with the hand blob and a little with speed, and shrinks with perspective deeper in. A solid hand paints with its own thickness (each bone or scan cell), scaled by this relative to the default 0.065.' },
    brightness: { kind: 'number', default: 1, min: 0, max: 3, step: .05, label: 'Brightness', description: 'How much light each stroke deposits. Overlapping strokes bloom toward white.' },
    hue: { kind: 'number', default: .055, min: 0, max: 1, step: .005, label: 'Hue', description: 'Base hue of the light: 0 red, 0.33 green, 0.66 blue.' },
    hueDrift: { kind: 'number', default: .02, min: 0, max: .2, step: .001, unit: 'Hz', label: 'Hue drift', description: 'How fast the hue wanders (at most ±0.08 around the base hue, so the palette stays coherent).' },
    saturation: { kind: 'number', default: .55, min: 0, max: 1, step: .01, label: 'Saturation', description: 'Colour saturation of the stroke edges; the core always reads warm-white.' },
    depthFade: { kind: 'number', default: .6, min: 0, max: 1, step: .01, label: 'Depth fade', description: 'Aerial perspective: how much strokes laid down deeper in the volume dim and cool (perspective already makes them smaller and draws them toward the centre). Also fogs deep sparkles.' },
    floor: { kind: 'number', default: .8, min: 0, max: 2, step: .05, label: 'Floor light', description: 'Brightness of the soft pool of light a hand casts on the floor of the volume, the depth cue; fades with presence.' },
    ghost: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Ghost', description: 'Brightness of the faint translucent body that is painting: the scanned surface or the skeleton, ray-marched in the volume. Nothing for a bare position.' },
    sparkle: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Sparkle', description: 'Amount of sparkles shed from the fingertips (or the silhouette edge of a scan) along the stroke.' },
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

    const decay = quadProgram(gl, DECAY_FS, 'afterglow-decay');
    const strokeProgram = new Program(gl, STROKE_VS, STROKE_FS, 'afterglow-strokes');
    const poolProgram = new Program(gl, POOL_VS, POOL_FS, 'afterglow-pools');
    const ghostProgram = new Program(gl, GHOST_VS, GHOST_FS, 'afterglow-ghost');
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

    // --- instanced geometry ---------------------------------------------
    /** A VAO whose only attributes are per-instance vec4s read from one interleaved buffer; the quad corners come from gl_VertexID. */
    function instanced(program: Program, names: string[], instances: number) {
      const vao = gl.createVertexArray(), vbo = gl.createBuffer();
      if (!vao || !vbo) throw new Error('Could not create instance buffers.');
      const stride = names.length * 16;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, instances * stride, gl.DYNAMIC_DRAW);
      names.forEach((name, i) => { const loc = program.attribute(name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, i * 16); gl.vertexAttribDivisor(loc, 1); });
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return { vao, vbo, data: new Float32Array(instances * names.length * 4) };
    }
    const strokeGeo = instanced(strokeProgram, ['a_prev', 'a_curr', 'a_col'], MAX_STROKES);
    const poolGeo = instanced(poolProgram, ['a_pool'], MAX_POOLS);
    const ghostGeo = instanced(ghostProgram, ['a_bound'], MAX_HAND_BOUNDS);
    function drawInstances(geo: { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; data: Float32Array }, floats: number, count: number) {
      gl.bindBuffer(gl.ARRAY_BUFFER, geo.vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, geo.data, 0, count * floats); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(geo.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count); gl.bindVertexArray(null);
    }

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

    // --- the solid, for the ghost -----------------------------------------
    const packed = createPackedHands();
    const surfaceTexture = new SurfaceTexture(gl);

    // --- CPU state ------------------------------------------------------
    const strokes = new StrokeTracker();
    const painter = new SurfacePainter();
    const scan = createScanStrokes();
    const sparkles = new SparkleField(capacity);
    const inkDepth = new InkDepth();
    const hueNoise = new Noise(11);
    const stepStrokes: CapsuleStroke[] = [];
    const pending: CapsuleStroke[] = [], pendingPools: StrokeSegment[] = [];
    let pendingDt = 0, time = 0, hue = 0, ink = 0, glow = 0, coverage = 0, presence = 0;
    let hands: SimInput['hands'] = [], surface: SimInput['surface'] = null;

    return {
      step(input: SimInput, params) {
        time = input.time; presence = input.presence; hands = input.hands; surface = input.surface;
        hue = hueWander(params.hue, time, params.hueDrift, hueNoise);
        const brush = { brushSize: params.brushSize, brightness: params.brightness, saturation: params.saturation, hue, depthFade: params.depthFade };
        const segments = strokes.update(input.hands, aspect, depth, input.dt, brush);
        // The scan paints when there is one, else the skeleton or the point brush; the hand-level segments still drive pool, ink, depth and the sparkle budget.
        let scanned: typeof scan | null = null;
        if (input.surface) scanned = painter.update(input.surface, segments, aspect, depth, brush, scan); else painter.reset();
        const painting = paintingStrokes(scanned, segments, stepStrokes);
        if (pending.length + painting.length > MAX_STROKES) pending.splice(0, pending.length + painting.length - MAX_STROKES);
        for (const s of painting) pending.push(s);
        let energy = 0, budget = 0;
        for (const s of segments) {
          if (pendingPools.length >= MAX_POOLS) pendingPools.shift();
          pendingPools.push(s);
          energy += s.amplitude;
          const rate = params.sparkle * sparkleRate(s.length, s.radius, input.dt);
          if (scanned) budget += rate;
          else if (rate > 0) sparkles.emitFrom(s.strokes, rate, sparkColour(s.r, s.g, s.b));
        }
        if (scanned && budget > 0 && segments.length) sparkles.emitFrom(scanned.edges, budget, sparkColour(segments[0].r, segments[0].g, segments[0].b));
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
        if (elapsed > 0 || pending.length || pendingPools.length) {
          const decayBy = decayFor(elapsed, params.lifetime), floorBy = floorFor(params.lifetime, hdr) * elapsed;
          // 1. Decay the previous frame.
          accum.write.bind();
          decay.use().texture('u_prev', accum.read.texture, 0).f1('u_decay', decayBy).f1('u_floor', floorBy);
          drawQuad(gl);
          // 2. This frame's sweeps, projected onto the glass, then the floor pools; both saturate against the decayed previous frame.
          const count = Math.min(MAX_STROKES, pending.length), pools = Math.min(MAX_POOLS, pendingPools.length);
          if (count || pools) {
            gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
            if (count) {
              const d = strokeGeo.data;
              for (let i = 0; i < count; i++) {
                const s = pending[i], p = projectSweep(s, camera), o = i * FLOATS_PER_STROKE;
                d[o] = p.ax0; d[o + 1] = p.ay0; d[o + 2] = p.bx0; d[o + 3] = p.by0;
                d[o + 4] = p.ax1; d[o + 5] = p.ay1; d[o + 6] = p.bx1; d[o + 7] = p.by1;
                d[o + 8] = s.r * s.amplitude; d[o + 9] = s.g * s.amplitude; d[o + 10] = s.b * s.amplitude; d[o + 11] = p.radius;
              }
              strokeProgram.use().texture('u_prev', accum.read.texture, 0).f2('u_texel', 1 / accum.width, 1 / accum.height)
                .f1('u_decay', decayBy).f1('u_floor', floorBy).f1('u_headK', HEAD_K).f1('u_aspect', aspect);
              drawInstances(strokeGeo, FLOATS_PER_STROKE, count);
            }
            if (pools) {
              const d = poolGeo.data;
              for (let i = 0; i < pools; i++) {
                const s = pendingPools[i], pool = projectFloorPool(s, camera), o = i * FLOATS_PER_POOL;
                d[o] = pool.x; d[o + 1] = pool.y; d[o + 2] = pool.rx; d[o + 3] = s.amplitude * pool.gain;
              }
              poolProgram.use().texture('u_prev', accum.read.texture, 0).f2('u_texel', 1 / accum.width, 1 / accum.height)
                .f1('u_decay', decayBy).f1('u_floor', floorBy).f1('u_headK', HEAD_K).f1('u_aspect', aspect).f1('u_eye', camera.eye);
              drawInstances(poolGeo, FLOATS_PER_POOL, pools);
            }
            gl.disable(gl.BLEND);
          }
          accum.swap(); pendingDt = 0; pending.length = 0; pendingPools.length = 0;
          // 3. Bloom at quarter resolution.
          bloomA.bind();
          downsample.use().texture('u_src', accum.read.texture, 0).f2('u_texel', 1 / accum.width, 1 / accum.height).f1('u_exposure', EXPOSURE).f1('u_threshold', BLOOM_THRESHOLD);
          drawQuad(gl);
          bloomB.bind(); blur.use().texture('u_src', bloomA.texture, 0).f2('u_dir', 1 / bloomA.width, 0); drawQuad(gl);
          bloomA.bind(); blur.use().texture('u_src', bloomB.texture, 0).f2('u_dir', 0, 1 / bloomA.height); drawQuad(gl);
        }
        // 4. Composite to the screen, then sparkles and the ghost on top.
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
        // The ghost of the solid that is painting: the scan when there is one, else the skeleton; nothing for a bare position.
        if (params.ghost > 0) {
          const bounds = ghostGeo.data;
          let count = 0, mode = 0;
          const scanReady = surface ? surfaceTexture.upload(surface) : false;
          if (scanReady) {
            const b = scanBounds(surface!, aspect);
            if (b) { bounds[0] = b.x; bounds[1] = b.y; bounds[2] = 0; bounds[3] = b.r; count = 1; mode = 1; }
          } else if (hands.some(h => h.capsules.length)) {
            packHands(hands.filter(h => h.capsules.length), aspect, depth, packed);
            bounds.set(packed.bounds.subarray(0, packed.boundCount * FLOATS_PER_BOUND)); count = packed.boundCount;
          }
          if (count) {
            const [r, g, b] = hsv(hue, params.saturation, 1);
            gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
            const program = ghostProgram.use().matrix4('u_matrix', camera.matrix).f1('u_aspect', aspect).f1('u_eye', camera.eye).f1('u_depth', depth)
              .f1('u_ghost', params.ghost).i1('u_mode', mode).f3('u_color', r, g, b).i1('u_surfaceReady', mode);
            if (mode === 1) program.texture('u_surface', surfaceTexture.texture, 0).f2('u_surfaceTexel', 1 / Math.max(1, surfaceTexture.width), 1 / Math.max(1, surfaceTexture.height)).f1('u_surfaceAspect', aspect).f1('u_surfaceDepth', depth);
            else program.f4v('u_capsules', packed.capsules).i1('u_capsuleCount', packed.count).f4v('u_handBounds', packed.bounds).i1('u_handBoundCount', packed.boundCount);
            drawInstances(ghostGeo, FLOATS_PER_BOUND, count);
            gl.disable(gl.BLEND);
          }
        }
        // 5. Queue a probe readback for a later frame's signals, if a slot is free.
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
        strokes.reset(); painter.reset(); pending.length = 0; pendingPools.length = 0;
      },

      dispose() {
        for (const { buffer, fence } of inFlight) { gl.deleteSync(fence); gl.deleteBuffer(buffer); }
        inFlight.length = 0;
        decay.dispose(); strokeProgram.dispose(); poolProgram.dispose(); ghostProgram.dispose(); downsample.dispose(); blur.dispose(); composite.dispose(); probeProgram.dispose(); points.dispose();
        accum.dispose(); bloomA.dispose(); bloomB.dispose(); probe.dispose(); surfaceTexture.dispose();
        for (const geo of [strokeGeo, poolGeo, ghostGeo]) { gl.deleteVertexArray(geo.vao); gl.deleteBuffer(geo.vbo); }
        gl.deleteVertexArray(vao); gl.deleteBuffer(vbo);
      },
    };
  },
});
