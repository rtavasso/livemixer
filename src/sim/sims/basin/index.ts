/**
 * Basin — clear water in glazed porcelain, holding drops of
 * ink that the hand can stir.
 *
 * The bowl sits on the floor of the volume. The water is the horizontal
 * x/depth plane, projected through a perspective camera (`view.ts`). Changing
 * the camera never changes physical input coordinates or mixer signals.
 * The hand's HEIGHT (sim y) decides whether it is in the
 * water: the surface sits at the `surface` parameter. A hand above it only
 * casts a shadow on the water; a fingertip touching it stirs gently; a plunged
 * hand stirs hard; and a fast crossing of the surface splashes a fresh bead.
 *
 * The hand is a solid. A depth camera's scan (`input.surface`) is preferred:
 * its cells at or below the water level are the wet footprint and its
 * silhouette the shadow. Otherwise a skeleton source's capsules: each capsule
 * dipping below the surface stirs with its own footprint (so dipped fingertips
 * make five small stirs, a flat palm one broad push), the shadow is the union
 * of the capsules, and the meniscus ring follows every capsule that crosses
 * the surface. Sources that only know a position get the sphere.
 *
 * Physics: GPU stable fluids (Stam) on a square grid in uniform units; the
 * bowl is a circle masked analytically in every pass (no-slip at the wall,
 * Neumann pressure at the wall). One physics step per `step()` call:
 *   advect velocity + forces → curl → vorticity confinement → divergence →
 *   Jacobi pressure ×N → gradient subtraction → advect dye + ink drops.
 * A separate damped wave field (`waves.ts`) responds to drops and wet motion.
 * Rendering: one full-screen composite pass, plus a 16×16 probe pass that is
 * read back asynchronously (PBO + fence) for the signals.
 *
 * Everything that can be tested without a GPU lives in `model.ts`.
 */
import { defineSimulation, type SimInput, type SurfaceField } from '../../core/types';
import { approach, clamp, clamp01, smoothstep } from '../../core/math';
import { hexToRgb } from '../../core/params';
import { Fbo, PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { drawQuad, quadProgram } from '../../gl/quad';
import { SurfaceTexture } from '../../gl/surface';
import type { Program } from '../../gl/program';
import {
  DEFAULT_PALETTE, DropScheduler, Footprints, GRID_BY_QUALITY, JACOBI_BY_QUALITY, MAX_FOOTPRINTS, MAX_SHADOW_CAPSULES, PACKED_DECAY_STRIDE, PACKED_FADE_STRIDE,
  PACKED_VELOCITY_SCALE, PALETTE_NAMES, PROBE_SIZE, ScanMotion, SignalSmoother, SolidShadow, causticOffsets, decodeProbe, dilateScanDepth, dissipation,
  dissipationFloor, domainScale, driftPhases, emptyGridHand, emptyScanMeasure, handToGrid, immersionSignal, measureScan, measuresToSignals, probeWeights,
  type Drop, type DropContext, type Measures,
} from './model';
import * as glsl from './shaders';
import { WAVE_FS, WAVE_GRID } from './waves';
import { DEFAULT_ELEVATION } from './view';

const PACKED_ZERO = 128 / 255;
const INITIAL_DROPS = 4;
const SEED = 7;
const NONE: readonly never[] = [];

/** A hand's presence over the water as the composite draws it: its solid on the plane, lingering and fading after the hand leaves. */
interface Shadow { id: number; opacity: number; present: boolean; solid: SolidShadow }

export default defineSimulation({
  id: 'basin',
  title: 'Basin',
  description: 'Ink in a glazed porcelain basin. Dip and sweep your hand to send ripples across the water and pull pigment into curling filaments. Window reflections bend with the waves; submerged colour absorbs the light.',
  params: {
    viscosity: { kind: 'number', default: .2, min: 0, max: 2, step: .01, unit: '1/s', label: 'Viscosity', description: 'Velocity dissipation rate: how quickly the water calms once nothing stirs it.' },
    vorticity: { kind: 'number', default: .2, min: 0, max: 1, step: .01, label: 'Vorticity', description: 'Vorticity confinement: keeps small eddies alive so the ink curls into filaments.' },
    stir: { kind: 'number', default: 1, min: 0, max: 2.5, step: .01, label: 'Stir', description: 'How strongly a plunged hand drags the water (1 = water under the hand follows it); a hand that only touches the surface stirs proportionally less.' },
    ink: { kind: 'number', default: .055, min: .02, max: .12, step: .005, label: 'Drop size', description: 'Radius of a fresh ink bead, in uniform units (canvas height = 1).' },
    palette: { kind: 'select', default: DEFAULT_PALETTE, options: PALETTE_NAMES, label: 'Palette', description: 'Ink colour set. Drops cycle through the palette.' },
    fade: { kind: 'number', default: .03, min: 0, max: .3, step: .005, unit: '1/s', label: 'Fade', description: 'Dye dissipation rate: how quickly ink dilutes to nothing.' },
    bowl: { kind: 'number', default: .42, min: .2, max: .48, step: .005, label: 'Bowl radius', description: 'Radius of the bowl as a fraction of the shorter canvas side (uniform units on a landscape display).' },
    surface: { kind: 'number', default: .35, min: .05, max: .9, step: .01, label: 'Water level', description: 'Height of the water surface in the volume (sim y: 0 = the table, 1 = the top of the volume). A hand whose underside is below it is in the water.' },
    dropOnEnter: { kind: 'boolean', default: true, label: 'Drop on dip', description: 'Drop a gentle bead where a hand dips into the water. A fast plunge always drops one, with a splash.' },
    light: { kind: 'number', default: 1, min: 0, max: 2, step: .01, label: 'Highlight', description: 'Strength of the window reflection, glints and waterline rings on the water surface.' },
    caustics: { kind: 'number', default: .7, min: 0, max: 2, step: .01, label: 'Caustics', description: 'Brightness of the refracted light playing on the bowl floor.' },
    ripples: { kind: 'number', default: .65, min: 0, max: 1.5, step: .01, label: 'Ripples', description: 'Surface response to drops and moving hands. Waves travel, reflect off the rim, and settle independently of the ink.' },
    glaze: { kind: 'color', default: '#a6a394', label: 'Bowl glaze', description: 'Ceramic colour beneath the clear water. Pale glazes reveal pigment; dark glazes emphasize reflections.' },
    ceramicTexture: { kind: 'number', default: 1, min: 0, max: 1.5, step: .05, label: 'Ceramic texture', description: 'Fine speckles, wheel marks and glaze variation in the submerged bowl. Set to zero for a smooth finish.' },
    elevation: { kind: 'number', default: DEFAULT_ELEVATION, min: 35, max: 90, step: 1, unit: '°', label: 'Camera elevation', description: 'Angle above the table: 40° shows the bowl profile and water depth; 90° looks straight down. Physics and mixer signals are unchanged.' },
  },
  signals: {
    energy: { min: 0, max: 1, description: 'Mean water speed inside the bowl, normalised.', smoothing: .15 },
    swirl: { min: 0, max: 1, description: 'Mean |curl| of the flow, normalised.', smoothing: .2 },
    rotation: { min: -1, max: 1, description: 'Net angular momentum about the bowl centre; positive = counter-clockwise.', smoothing: .35 },
    ink: { min: 0, max: 1, description: 'Fraction of the bowl covered by visible ink.', smoothing: .4 },
    calm: { min: 0, max: 1, description: '1 − slowly smoothed energy: high when the water has settled.', smoothing: 1.2 },
    immersion: { min: 0, max: 1, description: 'How much of the hand is under the water surface inside the bowl: the submerged share of the scan or of the skeleton\'s capsule length (0 above it or over the table, 1 fully plunged). Smoothed.', smoothing: .12 },
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
    const correctedDye = ctx.quality !== 'low';

    // Programs.
    const pAdvect = quadProgram(gl, glsl.advectVelocity(packed), 'basin.advect');
    const pCurl = quadProgram(gl, glsl.curl(packed), 'basin.curl');
    const pVorticity = quadProgram(gl, glsl.vorticity(packed), 'basin.vorticity');
    const pDivergence = quadProgram(gl, glsl.divergence(packed), 'basin.divergence');
    const pJacobi = quadProgram(gl, glsl.jacobi(packed), 'basin.jacobi');
    const pGradient = quadProgram(gl, glsl.gradientSubtract(packed), 'basin.gradient');
    const pDye = quadProgram(gl, glsl.advectDye(packed, correctedDye), 'basin.dye');
    const pPredict = correctedDye ? quadProgram(gl, glsl.predictDye(packed), 'basin.dye-predict') : null;
    const pProbe = quadProgram(gl, glsl.probe(packed), 'basin.probe');
    const pComposite = quadProgram(gl, glsl.composite(packed), 'basin.composite');
    const pWave = quadProgram(gl, WAVE_FS, 'basin.waves');
    const programs = [pAdvect, pCurl, pVorticity, pDivergence, pJacobi, pGradient, pDye, pProbe, pComposite, pWave];
    if (pPredict) programs.push(pPredict);
    const waveN = WAVE_GRID[ctx.quality];
    const wave = new PingPong(gl, waveN, waveN, 'rgba8', 'linear');
    for (const f of [wave.read, wave.write]) f.clear(128 / 255, 0, 128 / 255, 0);
    const waveForces = new Float32Array(8 * 4);
    let waveForceCount = 0, nextWake = 0;
    const waveForce = (x: number, y: number, radius: number, strength: number) => {
      if (waveForceCount === 8 || Math.abs(strength) < .0001) return;
      const o = waveForceCount++ * 4;
      waveForces[o] = x; waveForces[o + 1] = y; waveForces[o + 2] = Math.max(.015, radius); waveForces[o + 3] = clamp(strength, -.06, .06);
    };

    // Targets. The sim grid is fixed; only the composite depends on the canvas.
    const velocity = new PingPong(gl, N, N, format, 'linear');
    const dye = new PingPong(gl, dyeN, dyeN, format, 'linear');
    const dyePrediction = correctedDye ? new Fbo(gl, dyeN, dyeN, format, 'linear') : null;
    const pressure = new PingPong(gl, N, N, format, 'linear');
    const divergence = new Fbo(gl, N, N, format, 'linear');
    const curl = new Fbo(gl, N, N, format, 'linear');
    const probe = new Fbo(gl, PROBE_SIZE, PROBE_SIZE, 'rgba8', 'nearest');
    const zero = packed ? PACKED_ZERO : 0;
    for (const pp of [velocity, pressure]) { pp.read.clear(zero, zero, 0, 1); pp.write.clear(zero, zero, 0, 1); }
    divergence.clear(zero, 0, 0, 1); curl.clear(zero, 0, 0, 1);
    dye.clear();
    // The scan, uploaded once per new field (the tracker makes a new one per source frame) with its edges dilated.
    const scanTexture = new SurfaceTexture(gl);
    let scanDilated: SurfaceField | null = null, scanUploaded: SurfaceField | null = null;

    // Async probe readback: readPixels into a fresh 1 KB PBO behind a fence, collected once the
    // fence has signalled (a frame or two later), so the CPU never waits on the GPU for signals.
    // A buffer is never rewritten after being fenced: Chrome keeps a shadow copy per fenced
    // READ-usage buffer and warns when one is overwritten before it is consumed.
    const probeBytes = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    const MAX_IN_FLIGHT = 3;
    const inFlight: { buffer: WebGLBuffer; fence: WebGLSync }[] = []; // oldest first

    // CPU state. The step allocates nothing while hands are steady: footprints and drops are written
    // into typed arrays by index, the drop scheduler appends into `pending` and reuses its scratch
    // set, shadow records are created only when a hand arrives, and the shader time terms are
    // reduced into scratch buffers (see model.ts on why `u_time` is never passed raw).
    const scheduler = new DropScheduler(SEED);
    const smoother = new SignalSmoother();
    let weights = probeWeights(.42), weightsBowl = .42;
    let measures: Measures = { speed: 0, curl: 0, angular: 0, ink: 0 };
    const pending: Drop[] = [];
    const shadows: Shadow[] = [];
    let seeded = false;
    let stepIndex = 0;
    let lastRenderTime = -1;
    let presence = 0;
    let immersion = 0;
    const footprints = new Footprints();
    const scan = emptyScanMeasure(), scanMotion = new ScanMotion();
    let scanOpacity = 0, scanWet = 0, scanLevel = .35, scanActive = false;
    const capSeg = new Float32Array(MAX_SHADOW_CAPSULES * 4), capMeta = new Float32Array(MAX_SHADOW_CAPSULES * 4);
    const shadowHands = new Float32Array(glsl.MAX_HANDS * 4), shadowMeta = new Float32Array(glsl.MAX_HANDS * 4);
    const dropImpulse = new Float32Array(glsl.MAX_DROPS * 4), dropData = new Float32Array(glsl.MAX_DROPS * 4), dropColor = new Float32Array(glsl.MAX_DROPS * 3);
    const gridHand = emptyGridHand();
    const dropCtx: DropContext = { time: 0, hands: NONE, aspect: 1, bowl: .42, surface: .35, ink: .05, palette: DEFAULT_PALETTE, dropOnEnter: true, inkLevel: 0 };
    const driftPhase = new Float32Array(4), caustic = new Float32Array(8);

    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);

    const common = (p: Program, bowl: number) => p.use().f2('u_texel', texel, texel).f1('u_bowl', bowl);
    const run = (target: Fbo) => { target.bind(); drawQuad(gl); };
    /** The scan's uniforms for a pass: the texture, the grid → sim mapping and the row span to sample. */
    const scanUniforms = (p: Program, unit: number, rowMin: number, rowSpan: number, wetGate: number) => {
      const s = domainScale(ctx.aspect);
      p.texture('u_surface', scanTexture.texture, unit).i1('u_surfaceReady', scanActive && scanTexture.texture ? 1 : 0)
        .f2('u_surfaceTexel', 1 / Math.max(1, scanTexture.width), 1 / Math.max(1, scanTexture.height)).f1('u_surfaceAspect', ctx.aspect).f1('u_surfaceDepth', ctx.depth)
        .f4('u_scanMap', s / ctx.aspect, .5 - .5 * s / ctx.aspect, s, .5 - .5 * s)
        .f4('u_scanRows', rowMin, rowSpan, scanLevel, wetGate);
    };

    return {
      step(input: SimInput, params) {
        const dt = input.dt, bowl = params.bowl, surface = params.surface, step = stepIndex++;
        waveForceCount = 0;
        const wake = input.time >= nextWake;
        if (wake) nextWake = input.time + .1;
        presence = input.presence; scanLevel = surface;
        if (weightsBowl !== bowl) { weights = probeWeights(bowl); weightsBowl = bowl; }
        if (!seeded) { seeded = true; for (const d of scheduler.initial(INITIAL_DROPS, bowl, params.palette, params.ink)) pending.push(d); }
        dropCtx.time = input.time; dropCtx.hands = input.hands; dropCtx.aspect = ctx.aspect; dropCtx.bowl = bowl; dropCtx.surface = surface;
        dropCtx.ink = params.ink; dropCtx.palette = params.palette; dropCtx.dropOnEnter = params.dropOnEnter; dropCtx.inkLevel = smoother.values.ink;
        scheduler.update(dropCtx, pending);
        // Take up to MAX_DROPS from the front of the queue: impulses for the velocity pass, beads for the dye pass.
        const dropCount = Math.min(pending.length, glsl.MAX_DROPS);
        let impulses = 0;
        for (let i = 0; i < dropCount; i++) {
          const d = pending[i], o = i * 4, c = i * 3;
          dropData[o] = d.x; dropData[o + 1] = d.y; dropData[o + 2] = d.radius; dropData[o + 3] = d.amount;
          dropColor[c] = d.color[0]; dropColor[c + 1] = d.color[1]; dropColor[c + 2] = d.color[2];
          waveForce(d.x, d.y, d.radius * .55, -(.016 + d.impulse * .07) * params.ripples);
          if (d.impulse > 0) { const k = impulses++ * 4; dropImpulse[k] = d.x; dropImpulse[k + 1] = d.y; dropImpulse[k + 2] = d.radius * 1.6; dropImpulse[k + 3] = d.impulse; }
        }
        if (dropCount) { pending.copyWithin(0, dropCount); pending.length -= dropCount; }

        // The scan, when there is one with something in it, is the hand: its wet cells stir and its silhouette shades.
        let immersionNow = 0;
        footprints.begin();
        for (let i = 0; i < shadows.length; i++) shadows[i].present = false;
        const field = input.surface;
        scanActive = !!field && measureScan(field, ctx.aspect, surface, scan).total > 0;
        if (field && scanActive) {
          if (field !== scanUploaded) { scanDilated = dilateScanDepth(field, scanDilated); scanTexture.upload(scanDilated); scanUploaded = field; }
          scanMotion.update(scan, dt);
          if (wake && scan.wet) waveForce(scan.cx, scan.cy, scan.wetRadius * .55, -Math.min(.05, Math.hypot(scanMotion.vx, scanMotion.vy) * .055 + Math.max(0, scanMotion.descent) * .04) * params.ripples);
          const wetShare = scan.wet / scan.total;
          immersionNow = immersionSignal({ x: scan.cx, y: scan.cy, immersion: wetShare }, bowl);
          scanWet = approach(scanWet, smoothstep(0, .01, wetShare), dt, .08);
          scanOpacity = approach(scanOpacity, 1, dt, .08);
        } else {
          scanMotion.reset();
          scanWet = approach(scanWet, 0, dt, .25);
          scanOpacity = approach(scanOpacity, 0, dt, .25);
        }

        // Hands → the water plane: footprints for the wet parts, a shadow record per hand. With a scan the
        // hands only feed the drop scheduler (the scan is the same matter, seen better).
        const handCount = scanActive ? 0 : Math.min(input.hands.length, glsl.MAX_HANDS);
        for (let i = 0; i < handCount; i++) {
          const hand = input.hands[i];
          const h = handToGrid(hand, ctx.aspect, surface, gridHand);
          if (wake && h.immersion > 0) waveForce(h.x, h.y, .026, -Math.min(.05, Math.hypot(h.vx, h.vy) * .055 + Math.max(0, h.descent) * .04) * Math.min(1, h.immersion * 5) * params.ripples);
          // Pressing down while in the water pushes it outward in a ring; the crossing itself splashes through the scheduler.
          const press = params.stir * 1.2 * clamp01(h.descent / .8) * Math.min(1, h.immersion * 5);
          if (hand === input.primary) immersionNow = immersionSignal(h, bowl);
          let s: Shadow | undefined;
          for (let k = 0; k < shadows.length; k++) if (shadows[k].id === hand.id) { s = shadows[k]; break; }
          if (!s) { s = { id: hand.id, opacity: 0, present: true, solid: new SolidShadow() }; shadows.push(s); }
          s.present = true; s.opacity = approach(s.opacity, 1, dt, .08);
          const solid = hand.capsules.length > 0;
          if (solid) s.solid.setSolid(hand.capsules, ctx.aspect, surface, h.x, h.y, dt); else s.solid.setSphere(h, ctx.aspect);
          // Each hand gets a fair share of the remaining footprint slots; the nearest to the surface come first.
          const budget = Math.max(1, Math.floor((MAX_FOOTPRINTS - footprints.count) / (handCount - i)));
          if (solid) footprints.addSolid(hand.capsules, ctx.aspect, surface, h.vx, h.vy, s.solid.rel, budget, params.stir, press);
          else footprints.addSphere(h, params.stir, press);
        }
        // Shadows of departed hands fade in place instead of vanishing.
        for (let i = shadows.length - 1; i >= 0; i--) {
          const s = shadows[i];
          if (s.present) continue;
          s.opacity = approach(s.opacity, 0, dt, .25);
          if (s.opacity < .01) shadows.splice(i, 1);
        }
        immersion = immersionNow;

        // 1. Advect velocity, dissipate, add forces.
        const scanPress = params.stir * 1.2 * clamp01(scanMotion.descent / .8) * Math.min(1, (scan.total ? scan.wet / scan.total : 0) * 5);
        common(pAdvect, bowl).texture('u_velocity', velocity.read.texture, 0)
          .f1('u_dt', dt).f1('u_decay', dissipation(params.viscosity, dt, packed, step, PACKED_DECAY_STRIDE))
          .f1('u_decayFloor', dissipationFloor(packed, step, PACKED_DECAY_STRIDE, PACKED_VELOCITY_SCALE))
          .f4v('u_driftPhase', driftPhases(input.time, driftPhase))
          .f1('u_drift', .008 * (1 - .6 * presence)).f1('u_couple', 1 - Math.exp(-dt * 14))
          .i1('u_footCount', footprints.count).f4v('u_footSeg', footprints.seg).f4v('u_footVel', footprints.vel).f4v('u_footMeta', footprints.meta)
          .i1('u_dropCount', impulses).f4v('u_drops', dropImpulse)
          .f4('u_scanVel', scanMotion.vx * params.stir, scanMotion.vy * params.stir, 0, 0)
          .f4('u_scanPress', scan.cx, scan.cy, scan.wetRadius, scanActive && scan.wet ? scanPress : 0);
        scanUniforms(pAdvect, 1, scan.minY, scanActive && scan.wet ? Math.max(0, Math.min(scan.maxY, surface) - scan.minY) + 1 / (scanTexture.height || 64) : 0, 0);
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
        if (pPredict && dyePrediction) {
          common(pPredict, bowl).texture('u_dye', dye.read.texture, 0).texture('u_velocity', velocity.read.texture, 1).f1('u_dt', dt);
          run(dyePrediction);
        }
        common(pDye, bowl).f2('u_texel', dyeTexel, dyeTexel).texture('u_dye', dye.read.texture, 0).texture('u_velocity', velocity.read.texture, 1)
          .texture('u_prediction', dyePrediction?.texture ?? dye.read.texture, 2)
          .f1('u_dt', dt).f1('u_fade', dissipation(params.fade, dt, packed, step, PACKED_FADE_STRIDE))
          .f1('u_fadeFloor', dissipationFloor(packed, step, PACKED_FADE_STRIDE, 1))
          .i1('u_dropCount', dropCount).f4v('u_drops', dropData).f3v('u_dropColor', dropColor);
        run(dye.write); dye.swap();
        // Independent surface displacement; no ink density is used as water height.
        pWave.use().texture('u_wave', wave.read.texture, 0).f2('u_texel', 1 / waveN, 1 / waveN)
          .f1('u_dt', dt).f1('u_bowl', bowl).i1('u_forceCount', waveForceCount).f4v('u_forces', waveForces);
        run(wave.write); wave.swap();
      },

      render(frame, params) {
        const bowl = params.bowl;
        const glaze = hexToRgb(params.glaze);
        const elevation = params.elevation * Math.PI / 180;
        // Pack every hand's capsules back to back; each hand's record says where its run starts.
        let first = 0, shadowCount = 0;
        for (let i = 0; i < shadows.length && i < glsl.MAX_HANDS; i++) {
          const s = shadows[i], solid = s.solid, n = Math.min(solid.count, MAX_SHADOW_CAPSULES - first);
          if (n <= 0) break;
          capSeg.set(solid.seg.subarray(0, n * 4), first * 4); capMeta.set(solid.meta.subarray(0, n * 4), first * 4);
          const o = shadowCount * 4;
          shadowHands[o] = solid.cx; shadowHands[o + 1] = solid.cy; shadowHands[o + 2] = solid.bound; shadowHands[o + 3] = s.opacity;
          shadowMeta[o] = first; shadowMeta[o + 1] = n; shadowMeta[o + 2] = 0; shadowMeta[o + 3] = 0;
          first += n; shadowCount++;
        }
        bindScreen(gl, frame.width, frame.height);
        common(pComposite, bowl).texture('u_dye', dye.read.texture, 0).texture('u_velocity', velocity.read.texture, 1).texture('u_pressure', pressure.read.texture, 2)
          .f2('u_pixel', 1 / frame.width, 1 / frame.height).f2('u_dyeTexel', dyeTexel, dyeTexel)
          .f1('u_aspect', frame.aspect).f1('u_domain', domainScale(frame.aspect))
          .f1('u_light', params.light).f1('u_caustics', params.caustics).f1('u_presence', presence)
          .texture('u_wave', wave.read.texture, 4).f2('u_waveTexel', 1 / waveN, 1 / waveN)
          .f3('u_glaze', glaze[0] ** 2.2, glaze[1] ** 2.2, glaze[2] ** 2.2)
          .f1('u_ceramicTexture', params.ceramicTexture)
          .f2('u_viewAngle', Math.sin(elevation), Math.cos(elevation))
          .i1('u_shadowCount', shadowCount).f4v('u_shadowHands', shadowHands).f4v('u_shadowMeta', shadowMeta).f4v('u_capSeg', capSeg).f4v('u_capMeta', capMeta)
          .f4('u_scan', scan.bx, scan.by, scan.bound, scanOpacity);
        scanUniforms(pComposite, 3, scan.minY, scan.total ? Math.max(0, scan.maxY - scan.minY) + 1 / (scanTexture.height || 64) : 0, scanWet * scanOpacity);
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
        smoother.update(measuresToSignals(measures, immersion), dt);
      },

      signals() { const v = smoother.values; return { energy: v.energy, swirl: v.swirl, rotation: v.rotation, ink: v.ink, calm: v.calm, immersion: v.immersion }; },

      paramChanged(name, value) {
        if (name === 'bowl' && typeof value === 'number' && value !== weightsBowl) { weights = probeWeights(value); weightsBowl = value; }
      },

      resize() { /* the grid is fixed; the composite reads the frame size each render */ },

      dispose() {
        for (const { buffer, fence } of inFlight) { gl.deleteSync(fence); gl.deleteBuffer(buffer); }
        inFlight.length = 0;
        shadows.length = 0; pending.length = 0;
        for (const p of programs) p.dispose();
        scanTexture.dispose();
        velocity.dispose(); dye.dispose(); dyePrediction?.dispose(); pressure.dispose(); divergence.dispose(); curl.dispose(); probe.dispose(); wave.dispose();
      },
    };
  },
});
