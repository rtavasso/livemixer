/**
 * Basin — a bowl of dark water holding drops of ink that the hand can stir.
 *
 * Physics: GPU stable fluids (Stam) on a square grid in uniform units; the
 * bowl is a circle masked analytically in every pass (no-slip at the wall,
 * Neumann pressure at the wall). One physics step per `step()` call:
 *   advect velocity + forces → curl → vorticity confinement → divergence →
 *   Jacobi pressure ×N → gradient subtraction → advect dye + ink drops.
 * Rendering: one full-screen composite pass, plus a 16×16 probe pass that is
 * read back asynchronously (PBO + fence) for the signals.
 *
 * Everything that can be tested without a GPU lives in `model.ts`.
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { clamp } from '../../core/math';
import { Fbo, PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { drawQuad, quadProgram } from '../../gl/quad';
import type { Program } from '../../gl/program';
import {
  DEFAULT_PALETTE, DropScheduler, GRID_BY_QUALITY, JACOBI_BY_QUALITY, PACKED_DECAY_STRIDE, PACKED_FADE_STRIDE, PACKED_VELOCITY_SCALE,
  PALETTE_NAMES, PROBE_SIZE, SignalSmoother, causticOffsets, decodeProbe, dissipation, dissipationFloor, domainScale, driftPhases,
  handToGrid, measuresToSignals, probeWeights, type Drop, type DropContext, type GridHand, type Measures,
} from './model';
import * as glsl from './shaders';

const PACKED_ZERO = 128 / 255;
const INITIAL_DROPS = 4;
const SEED = 7;
const NO_EVENTS: readonly never[] = [];

export default defineSimulation({
  id: 'basin',
  title: 'Basin',
  description: 'A bowl of dark water holding drops of ink. Moving the hand drags the water with it and the ink swirls into filaments; pressing in drops a fresh bead; left alone, the water calms and the ink settles into slow drift.',
  params: {
    viscosity: { kind: 'number', default: .2, min: 0, max: 2, step: .01, unit: '1/s', label: 'Viscosity', description: 'Velocity dissipation rate: how quickly the water calms once nothing stirs it.' },
    vorticity: { kind: 'number', default: .2, min: 0, max: 1, step: .01, label: 'Vorticity', description: 'Vorticity confinement: keeps small eddies alive so the ink curls into filaments.' },
    stir: { kind: 'number', default: 1, min: 0, max: 2.5, step: .01, label: 'Stir', description: 'How strongly the hand drags the water (1 = water under the hand follows it).' },
    ink: { kind: 'number', default: .055, min: .02, max: .12, step: .005, label: 'Drop size', description: 'Radius of a fresh ink bead, in uniform units (canvas height = 1).' },
    palette: { kind: 'select', default: DEFAULT_PALETTE, options: PALETTE_NAMES, label: 'Palette', description: 'Ink colour set. Drops cycle through the palette.' },
    fade: { kind: 'number', default: .03, min: 0, max: .3, step: .005, unit: '1/s', label: 'Fade', description: 'Dye dissipation rate: how quickly ink dilutes to nothing.' },
    bowl: { kind: 'number', default: .42, min: .2, max: .48, step: .005, label: 'Bowl radius', description: 'Radius of the bowl as a fraction of the shorter canvas side (uniform units on a landscape display).' },
    dropOnEnter: { kind: 'boolean', default: true, label: 'Drop on enter', description: 'Drop a bead of ink where a hand first appears.' },
    light: { kind: 'number', default: 1, min: 0, max: 2, step: .01, label: 'Highlight', description: 'Strength of the window reflection and glints on the water surface.' },
    caustics: { kind: 'number', default: .7, min: 0, max: 2, step: .01, label: 'Caustics', description: 'Brightness of the refracted light playing on the bowl floor.' },
  },
  signals: {
    energy: { min: 0, max: 1, description: 'Mean water speed inside the bowl, normalised.', smoothing: .15 },
    swirl: { min: 0, max: 1, description: 'Mean |curl| of the flow, normalised.', smoothing: .2 },
    rotation: { min: -1, max: 1, description: 'Net angular momentum about the bowl centre; positive = counter-clockwise.', smoothing: .35 },
    ink: { min: 0, max: 1, description: 'Fraction of the bowl covered by visible ink.', smoothing: .4 },
    calm: { min: 0, max: 1, description: '1 − slowly smoothed energy: high when the water has settled.', smoothing: 1.2 },
  },
  stepHz: 60,
  create(ctx) {
    const gl = ctx.gl;
    const format = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    const packed = format === 'rgba8';
    if (packed) ctx.warn('Basin: no half-float render targets; running the fluid with 8-bit precision.');
    const N = GRID_BY_QUALITY[ctx.quality];
    const dyeN = N * 2; // the dye lives on a finer grid so filaments survive advection
    const iterations = JACOBI_BY_QUALITY[ctx.quality];
    const texel = 1 / N, dyeTexel = 1 / dyeN;

    // Programs.
    const pAdvect = quadProgram(gl, glsl.advectVelocity(packed), 'basin.advect');
    const pCurl = quadProgram(gl, glsl.curl(packed), 'basin.curl');
    const pVorticity = quadProgram(gl, glsl.vorticity(packed), 'basin.vorticity');
    const pDivergence = quadProgram(gl, glsl.divergence(packed), 'basin.divergence');
    const pJacobi = quadProgram(gl, glsl.jacobi(packed), 'basin.jacobi');
    const pGradient = quadProgram(gl, glsl.gradientSubtract(packed), 'basin.gradient');
    const pDye = quadProgram(gl, glsl.advectDye(packed), 'basin.dye');
    const pProbe = quadProgram(gl, glsl.probe(packed), 'basin.probe');
    const pComposite = quadProgram(gl, glsl.composite(packed), 'basin.composite');
    const programs = [pAdvect, pCurl, pVorticity, pDivergence, pJacobi, pGradient, pDye, pProbe, pComposite];

    // Targets. The sim grid is fixed; only the composite depends on the canvas.
    const velocity = new PingPong(gl, N, N, format, 'linear');
    const dye = new PingPong(gl, dyeN, dyeN, format, 'linear');
    const pressure = new PingPong(gl, N, N, format, 'linear');
    const divergence = new Fbo(gl, N, N, format, 'linear');
    const curl = new Fbo(gl, N, N, format, 'linear');
    const probe = new Fbo(gl, PROBE_SIZE, PROBE_SIZE, 'rgba8', 'nearest');
    const zero = packed ? PACKED_ZERO : 0;
    for (const pp of [velocity, pressure]) { pp.read.clear(zero, zero, 0, 1); pp.write.clear(zero, zero, 0, 1); }
    divergence.clear(zero, 0, 0, 1); curl.clear(zero, 0, 0, 1);
    dye.clear();

    // Async probe readback: readPixels into a fresh 1 KB PBO behind a fence, collected once the
    // fence has signalled (a frame or two later), so the CPU never waits on the GPU for signals.
    // A buffer is never rewritten after being fenced: Chrome keeps a shadow copy per fenced
    // READ-usage buffer and warns when one is overwritten before it is consumed.
    const probeBytes = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    const MAX_IN_FLIGHT = 3;
    const inFlight: { buffer: WebGLBuffer; fence: WebGLSync }[] = []; // oldest first

    // CPU state. The step allocates nothing: hands and drops are written into these typed arrays by
    // index, the drop scheduler appends into `pending` and reuses its scratch sets, and the shader
    // time terms are reduced into scratch buffers (see model.ts on why `u_time` is never passed raw).
    const scheduler = new DropScheduler(SEED);
    const smoother = new SignalSmoother();
    let weights = probeWeights(.42), weightsBowl = .42;
    let measures: Measures = { speed: 0, curl: 0, angular: 0, ink: 0 };
    const pending: Drop[] = [];
    let seeded = false;
    let stepIndex = 0;
    let lastRenderTime = -1;
    let presence = 0;
    const handData = new Float32Array(glsl.MAX_HANDS * 4), handMeta = new Float32Array(glsl.MAX_HANDS * 4);
    const dropImpulse = new Float32Array(glsl.MAX_DROPS * 4), dropData = new Float32Array(glsl.MAX_DROPS * 4), dropColor = new Float32Array(glsl.MAX_DROPS * 3);
    const gridHand: GridHand = { x: 0, y: 0, vx: 0, vy: 0, radius: 0, push: 0 };
    const dropCtx: DropContext = { time: 0, events: NO_EVENTS, hands: NO_EVENTS, aspect: 1, bowl: .42, ink: .05, palette: DEFAULT_PALETTE, dropOnEnter: true, inkLevel: 0 };
    const driftPhase = new Float32Array(4), caustic = new Float32Array(8);

    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);

    const common = (p: Program, bowl: number) => p.use().f2('u_texel', texel, texel).f1('u_bowl', bowl);
    const run = (target: Fbo) => { target.bind(); drawQuad(gl); };

    return {
      step(input: SimInput, params) {
        const dt = input.dt, bowl = params.bowl, step = stepIndex++;
        presence = input.presence;
        if (weightsBowl !== bowl) { weights = probeWeights(bowl); weightsBowl = bowl; }
        if (!seeded) { seeded = true; for (const d of scheduler.initial(INITIAL_DROPS, bowl, params.palette, params.ink)) pending.push(d); }
        dropCtx.time = input.time; dropCtx.events = input.events; dropCtx.hands = input.hands; dropCtx.aspect = ctx.aspect; dropCtx.bowl = bowl;
        dropCtx.ink = params.ink; dropCtx.palette = params.palette; dropCtx.dropOnEnter = params.dropOnEnter; dropCtx.inkLevel = smoother.values.ink;
        scheduler.update(dropCtx, pending);
        // Take up to MAX_DROPS from the front of the queue: impulses for the velocity pass, beads for the dye pass.
        const dropCount = Math.min(pending.length, glsl.MAX_DROPS);
        let impulses = 0;
        for (let i = 0; i < dropCount; i++) {
          const d = pending[i], o = i * 4, c = i * 3;
          dropData[o] = d.x; dropData[o + 1] = d.y; dropData[o + 2] = d.radius; dropData[o + 3] = d.amount;
          dropColor[c] = d.color[0]; dropColor[c + 1] = d.color[1]; dropColor[c + 2] = d.color[2];
          if (d.impulse > 0) { const k = impulses++ * 4; dropImpulse[k] = d.x; dropImpulse[k + 1] = d.y; dropImpulse[k + 2] = d.radius * 1.6; dropImpulse[k + 3] = d.impulse; }
        }
        if (dropCount) { pending.copyWithin(0, dropCount); pending.length -= dropCount; }

        // Hands → grid units.
        const handCount = Math.min(input.hands.length, glsl.MAX_HANDS);
        for (let i = 0; i < handCount; i++) {
          const h = handToGrid(input.hands[i], ctx.aspect, gridHand), o = i * 4;
          handData[o] = h.x; handData[o + 1] = h.y; handData[o + 2] = h.vx; handData[o + 3] = h.vy;
          const press = clamp((h.push - .45) / .55, 0, 1);
          handMeta[o] = h.radius; handMeta[o + 1] = params.stir * (.55 + .45 * h.push); handMeta[o + 2] = press * 1.2 * params.stir; handMeta[o + 3] = 0;
        }

        // 1. Advect velocity, dissipate, add forces.
        common(pAdvect, bowl).texture('u_velocity', velocity.read.texture, 0)
          .f1('u_dt', dt).f1('u_decay', dissipation(params.viscosity, dt, packed, step, PACKED_DECAY_STRIDE))
          .f1('u_decayFloor', dissipationFloor(packed, step, PACKED_DECAY_STRIDE, PACKED_VELOCITY_SCALE))
          .f4v('u_driftPhase', driftPhases(input.time, driftPhase))
          .f1('u_drift', .008 * (1 - .6 * presence)).f1('u_couple', 1 - Math.exp(-dt * 14))
          .i1('u_handCount', handCount).f4v('u_hands', handData).f4v('u_handMeta', handMeta)
          .i1('u_dropCount', impulses).f4v('u_drops', dropImpulse);
        run(velocity.write); velocity.swap();
        // 2. Curl.
        common(pCurl, bowl).texture('u_velocity', velocity.read.texture, 0);
        run(curl);
        // 3. Vorticity confinement.
        common(pVorticity, bowl).texture('u_velocity', velocity.read.texture, 0).texture('u_curl', curl.texture, 1)
          .f1('u_vorticity', params.vorticity * 20).f1('u_dt', dt);
        run(velocity.write); velocity.swap();
        // 4. Divergence.
        common(pDivergence, bowl).texture('u_velocity', velocity.read.texture, 0);
        run(divergence);
        // 5. Pressure (warm-started from the previous step).
        common(pJacobi, bowl).texture('u_divergence', divergence.texture, 1);
        for (let i = 0; i < iterations; i++) {
          pJacobi.texture('u_pressure', pressure.read.texture, 0);
          run(pressure.write); pressure.swap();
        }
        // 6. Subtract the pressure gradient and enforce the wall.
        common(pGradient, bowl).texture('u_pressure', pressure.read.texture, 0).texture('u_velocity', velocity.read.texture, 1);
        run(velocity.write); velocity.swap();
        // 7. Advect the dye and drop ink.
        common(pDye, bowl).f2('u_texel', dyeTexel, dyeTexel).texture('u_dye', dye.read.texture, 0).texture('u_velocity', velocity.read.texture, 1)
          .f1('u_dt', dt).f1('u_fade', dissipation(params.fade, dt, packed, step, PACKED_FADE_STRIDE))
          .f1('u_fadeFloor', dissipationFloor(packed, step, PACKED_FADE_STRIDE, 1))
          .i1('u_dropCount', dropCount).f4v('u_drops', dropData).f3v('u_dropColor', dropColor);
        run(dye.write); dye.swap();
      },

      render(frame, params) {
        const bowl = params.bowl;
        bindScreen(gl, frame.width, frame.height);
        common(pComposite, bowl).texture('u_dye', dye.read.texture, 0).texture('u_velocity', velocity.read.texture, 1).texture('u_pressure', pressure.read.texture, 2)
          .f2('u_pixel', 1 / frame.width, 1 / frame.height).f2('u_dyeTexel', dyeTexel, dyeTexel)
          .f1('u_aspect', frame.aspect).f1('u_domain', domainScale(frame.aspect))
          .f1('u_light', params.light).f1('u_caustics', params.caustics).f1('u_presence', presence);
        causticOffsets(frame.time, caustic);
        pComposite.f4('u_caustT', caustic[0], caustic[1], caustic[2], caustic[3]).f4('u_caustT2', caustic[4], caustic[5], caustic[6], caustic[7]);
        drawQuad(gl);

        // Collect finished probe readbacks (oldest first; the newest wins), then queue another if a slot is free.
        while (inFlight.length) {
          const { buffer, fence } = inFlight[0];
          const status = gl.clientWaitSync(fence, 0, 0);
          if (status === gl.TIMEOUT_EXPIRED) break;
          inFlight.shift();
          if (status !== gl.WAIT_FAILED) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, probeBytes);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            measures = decodeProbe(probeBytes, weights);
          }
          gl.deleteSync(fence); gl.deleteBuffer(buffer);
        }
        if (inFlight.length < MAX_IN_FLIGHT) {
          const buffer = gl.createBuffer();
          if (buffer) {
            common(pProbe, bowl).texture('u_velocity', velocity.read.texture, 0).texture('u_curl', curl.texture, 1).texture('u_dye', dye.read.texture, 2);
            run(probe);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.bufferData(gl.PIXEL_PACK_BUFFER, probeBytes.byteLength, gl.STREAM_READ);
            gl.readPixels(0, 0, PROBE_SIZE, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (fence) inFlight.push({ buffer, fence }); else gl.deleteBuffer(buffer);
            gl.flush();
            bindScreen(gl, frame.width, frame.height);
          }
        }
        const dt = lastRenderTime < 0 ? 0 : clamp(frame.time - lastRenderTime, 0, .1);
        lastRenderTime = frame.time;
        smoother.update(measuresToSignals(measures), dt);
      },

      signals() { const v = smoother.values; return { energy: v.energy, swirl: v.swirl, rotation: v.rotation, ink: v.ink, calm: v.calm }; },

      paramChanged(name, value) {
        if (name === 'bowl' && typeof value === 'number' && value !== weightsBowl) { weights = probeWeights(value); weightsBowl = value; }
      },

      resize() { /* the grid is fixed; the composite reads the frame size each render */ },

      dispose() {
        for (const { buffer, fence } of inFlight) { gl.deleteSync(fence); gl.deleteBuffer(buffer); }
        inFlight.length = 0;
        for (const p of programs) p.dispose();
        velocity.dispose(); dye.dispose(); pressure.dispose(); divergence.dispose(); curl.dispose(); probe.dispose();
      },
    };
  },
});
