/**
 * Shallows — open water over sand, seen from straight above. There is no
 * vessel: the water fills the screen and its only walls are the screen edges,
 * so whatever a hand sets going runs out to them, comes back, and the whole
 * sheet sloshes until it settles. Sunlight falls through the surface, and the
 * waves bend it: caustic lines play over the sand, the bed swims under every
 * crest, and slopes that face the sun glint.
 *
 * The water is the volume's horizontal x/depth plane and the hand's HEIGHT
 * (sim y) decides whether it is in the water, exactly as in Basin: the surface
 * sits at the `level` parameter. A hand above it only casts a shadow through
 * the water onto the sand; crossing the surface splashes (harder when faster);
 * a submerged hand that moves pushes water ahead of itself and leaves a wake,
 * and one that presses down or lifts displaces the water around it.
 *
 * The hand is a solid, best available first: a depth camera's scan
 * (`input.surface`), a skeleton's capsules (each dipped finger its own narrow
 * wake, a flat palm a broad one), or a sphere. The geometry is Basin's
 * (`basin/model.ts`); `model.ts` here carries it onto the full-screen plane.
 *
 * Physics: one height/rate field, a few wave passes per fixed step (`model.ts`
 * has the equation and the stability bounds). Rendering: one full-screen
 * composite, plus a 16×16 probe read back asynchronously for the signals.
 */
import { defineSimulation, type SimInput, type SurfaceField } from '../../core/types';
import { approach, clamp, clamp01, smoothstep } from '../../core/math';
import { hexToRgb } from '../../core/params';
import { Fbo, PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { blit, drawQuad, quadProgram } from '../../gl/quad';
import { AsyncReadback } from '../../gl/readback';
import { SurfaceTexture } from '../../gl/surface';
import type { Program } from '../../gl/program';
import {
  Footprints, MAX_FOOTPRINTS, MAX_SHADOW_CAPSULES, ScanMotion, SolidShadow, dilateScanDepth, domainScale, emptyGridHand, emptyScanMeasure, handToGrid, measureScan,
} from '../basin/model';
import {
  HEIGHT_RELAX, PROBE_SIZE, SignalSmoother, SplashDetector, Stamps, Swell, decodeProbe, effectiveSpeed, fieldSize, gridToPlaneX, gridToPlaneY, measuresToSignals,
  rippleViscosity, substepsFor, type Measures,
} from './model';
import * as glsl from './shaders';

const SEED = 23;
/** Vertical acceleration on the water per unit of a gripped hand's vertical speed, and the impulse of a full plunge. */
const PRESS_GAIN = 6, SPLASH_IMPULSE = .45;
/** With height contact off the surface is put above the whole volume, so every hand is fully in the water wherever it is. */
const ALWAYS_WET_LEVEL = 2;
/** The scan has no hand id; its splashes are tracked under this one. */
const SCAN_ID = -1;

/** A hand's presence over the water as the composite draws it: its solid on the plane, lingering and fading after the hand leaves. */
interface Shadow { id: number; opacity: number; present: boolean; solid: SolidShadow }

export default defineSimulation({
  id: 'shallows',
  title: 'Shallows',
  description: 'Open water over sand, seen from straight above. Dip and sweep a hand to raise wakes and ripples that run to the edges, slosh back and settle, while sunlight falling through the waves draws caustics across the bed.',
  params: {
    heightContact: { kind: 'boolean', default: false, label: 'Height contact', description: 'On: the hand\'s height decides whether it touches the water (see Water level), so a raised hand only casts a shadow and crossing the surface splashes. Off: a hand always moves the water, whatever its height.' },
    level: { kind: 'number', default: .35, min: .05, max: .9, step: .01, label: 'Water level', description: 'Height of the water surface in the volume (sim y: 0 = the floor, 1 = the top of the volume). A hand whose underside is below it is in the water. Only used with Height contact on.' },
    force: { kind: 'number', default: 1, min: 0, max: 2.5, step: .01, label: 'Force', description: 'How much water a hand moves: the wake of a sweep, the push of a press and the size of a splash.' },
    speed: { kind: 'number', default: .5, min: .25, max: .8, step: .01, unit: '1/s', label: 'Wave speed', description: 'How fast waves travel, in screen heights per second. Slower water sloshes with a longer period.' },
    ripples: { kind: 'number', default: .5, min: 0, max: 1, step: .01, label: 'Ripples', description: 'How long short ripples live: 0 smooths them away at once, 1 lets them cross the screen. The long slosh is unaffected.' },
    settle: { kind: 'number', default: .2, min: .03, max: 1.5, step: .01, unit: '1/s', label: 'Settle', description: 'Damping of the whole sheet: how quickly the slosh between the screen edges comes to rest.' },
    breeze: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Breeze', description: 'Fine wind ripples over the whole surface, which draw the moving caustic network on the sand even when nobody is there. Zero leaves only the waves hands make, and still water shows a plain lit bed.' },
    depth: { kind: 'number', default: .22, min: .06, max: .5, step: .01, label: 'Depth', description: 'Depth of the water in screen heights. Deeper water bends the view further, focuses caustics harder and tints the sand more.' },
    refraction: { kind: 'number', default: 1, min: 0, max: 3, step: .01, label: 'Refraction', description: 'How far the sand appears to shift under a sloping surface (1 = physical for the depth).' },
    caustics: { kind: 'number', default: .85, min: 0, max: 1, step: .01, label: 'Caustics', description: 'Strength of the light focused onto the sand by the waves.' },
    dispersion: { kind: 'number', default: .5, min: 0, max: 1, step: .01, label: 'Dispersion', description: 'Colour fringing of the caustic lines: red, green and blue light bend by slightly different amounts.' },
    light: { kind: 'number', default: 1, min: 0, max: 2, step: .01, label: 'Sunlight', description: 'Brightness of the sun on the sand, the glints on the surface and the waterline rings.' },
    clarity: { kind: 'number', default: .9, min: 0, max: 1, step: .01, label: 'Clarity', description: 'How clear the water is: 1 barely tints the sand, 0 is strongly coloured.' },
    water: { kind: 'color', default: '#2f9ad0', label: 'Water', description: 'Colour the water lends to light that travels through it.' },
    sand: { kind: 'color', default: '#e3c9a0', label: 'Sand', description: 'Colour of the sand bed.' },
    sandTexture: { kind: 'number', default: 1, min: 0, max: 1.5, step: .05, label: 'Sand texture', description: 'Ripple marks, grain, flecks and pebbles on the bed. Zero is a plain bed.' },
  },
  signals: {
    energy: { min: 0, max: 1, description: 'Mean vertical speed of the surface, normalised: how much the water is moving.', smoothing: .15 },
    sloshX: { min: -1, max: 1, description: 'Tilt of the whole sheet across the screen: positive when the water is piled up on the right. Swings back and forth as the slosh rocks.', smoothing: .08 },
    sloshZ: { min: -1, max: 1, description: 'Tilt of the whole sheet in depth: positive when the water is piled up at the back (top of the screen).', smoothing: .08 },
    ripple: { min: 0, max: 1, description: 'Short-wavelength activity (mean surface curvature), normalised: high for fresh ripples and splashes, near zero for a pure slosh.', smoothing: .2 },
    calm: { min: 0, max: 1, description: '1 − slowly smoothed energy: high when the water has settled.', smoothing: 1.5 },
    immersion: { min: 0, max: 1, description: 'How much of the hand is under the water surface: the submerged share of the scan or of the skeleton\'s capsule length. Smoothed.', smoothing: .12 },
  },
  stepHz: 60,
  create(ctx) {
    const gl = ctx.gl;
    // Full floats keep the slow slosh alive longest; half floats are fine; 8-bit packing still runs.
    const format = pickFormat(ctx.capabilities, ['rgba32f', 'rgba16f', 'rgba8']);
    const packed = format === 'rgba8';
    if (packed) ctx.warn('Shallows: no float render targets; running the water with reduced precision.');
    const rest = glsl.restColor(packed);

    const pWave = quadProgram(gl, glsl.wave(packed), 'shallows.wave');
    const pProbe = quadProgram(gl, glsl.probe(packed), 'shallows.probe');
    const pComposite = quadProgram(gl, glsl.composite(packed), 'shallows.composite');

    const newField = (aspect: number) => {
      const size = fieldSize(ctx.quality, aspect);
      const f = new PingPong(gl, size.width, size.height, format, 'linear');
      f.read.clear(...rest); f.write.clear(...rest);
      return f;
    };
    let field = newField(ctx.aspect);
    const probeTarget = new Fbo(gl, PROBE_SIZE, PROBE_SIZE, 'rgba8', 'nearest');
    const readback = new AsyncReadback(gl, PROBE_SIZE, PROBE_SIZE);
    // The scan, uploaded once per new field (the tracker makes a new one per source frame) with its edges dilated.
    const scanTexture = new SurfaceTexture(gl);
    let scanDilated: SurfaceField | null = null, scanUploaded: SurfaceField | null = null;

    // CPU state. The step allocates nothing while hands are steady.
    const stamps = new Stamps(), footprints = new Footprints(), splashes = new SplashDetector(), swell = new Swell(SEED), smoother = new SignalSmoother();
    const seen = new Set<number>();
    const shadows: Shadow[] = [];
    const scan = emptyScanMeasure(), scanMotion = new ScanMotion();
    let scanOpacity = 0, scanWet = 0, scanLevel = .35, scanActive = false;
    let measures: Measures = { speed: 0, curvature: 0, tiltX: 0, tiltZ: 0 };
    let immersion = 0, lastRenderTime = -1;
    const gridHand = emptyGridHand();
    const capSeg = new Float32Array(MAX_SHADOW_CAPSULES * 4), capMeta = new Float32Array(MAX_SHADOW_CAPSULES * 4);
    const shadowHands = new Float32Array(glsl.MAX_HANDS * 4), shadowMeta = new Float32Array(glsl.MAX_HANDS * 4);

    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);

    const run = (target: Fbo) => { target.bind(); drawQuad(gl); };
    /** The scan's uniforms for the composite: the texture, the grid → sim mapping and the row span to sample. */
    const scanUniforms = (p: Program, unit: number, rowMin: number, rowSpan: number, wetGate: number) => {
      const s = domainScale(ctx.aspect);
      p.texture('u_surface', scanTexture.texture, unit).i1('u_surfaceReady', scanActive && scanTexture.texture ? 1 : 0)
        .f2('u_surfaceTexel', 1 / Math.max(1, scanTexture.width), 1 / Math.max(1, scanTexture.height))
        .f4('u_scanMap', s / ctx.aspect, .5 - .5 * s / ctx.aspect, s, .5 - .5 * s)
        .f4('u_scanRows', rowMin, rowSpan, scanLevel, wetGate);
    };

    return {
      step(input: SimInput, params) {
        const dt = input.dt, level = params.heightContact ? params.level : ALWAYS_WET_LEVEL, force = params.force, aspect = ctx.aspect, s = domainScale(aspect);
        scanLevel = level;
        stamps.begin(); footprints.begin(); seen.clear();
        for (let i = 0; i < shadows.length; i++) shadows[i].present = false;

        // The scan, when there is one with something in it, is the hand: its wet part moves the water and its silhouette shades the sand.
        let immersionNow = 0;
        const surface = input.surface;
        scanActive = !!surface && measureScan(surface, aspect, level, scan).total > 0;
        if (surface && scanActive) {
          if (surface !== scanUploaded) { scanDilated = dilateScanDepth(surface, scanDilated); scanTexture.upload(scanDilated); scanUploaded = surface; }
          scanMotion.update(scan, dt);
          seen.add(SCAN_ID);
          const splash = splashes.update(SCAN_ID, scan.lowest - level, scanMotion.descent, input.time);
          if (splash > 0 && scan.wet) stamps.addImpulse(gridToPlaneX(scan.cx, aspect), gridToPlaneY(scan.cy, aspect), clamp(scan.wetRadius * s, .03, .06), -SPLASH_IMPULSE * splash * force);
          stamps.addScan(scan, scanMotion.vx, scanMotion.vy, aspect, force, params.heightContact ? -PRESS_GAIN * force * Math.min(scanMotion.descent, 1.5) : 0);
          immersionNow = clamp01(scan.wet / scan.total);
          scanWet = approach(scanWet, smoothstep(0, .01, immersionNow), dt, .08);
          scanOpacity = approach(scanOpacity, 1, dt, .08);
        } else {
          scanMotion.reset();
          scanWet = approach(scanWet, 0, dt, .25);
          scanOpacity = approach(scanOpacity, 0, dt, .25);
        }

        // Hands → the water plane: footprints for the wet parts, a shadow record per hand. With a scan the
        // hands are the same matter seen less well, so only the scan acts.
        const handCount = scanActive ? 0 : Math.min(input.hands.length, glsl.MAX_HANDS);
        for (let i = 0; i < handCount; i++) {
          const hand = input.hands[i];
          const h = handToGrid(hand, aspect, level, gridHand);
          seen.add(hand.id);
          const splash = splashes.update(hand.id, h.clearance, h.descent, input.time);
          if (splash > 0) stamps.addImpulse(gridToPlaneX(h.x, aspect), gridToPlaneY(h.y, aspect), clamp(h.extent * s * .8, .03, .06), -SPLASH_IMPULSE * splash * force);
          if (hand === input.primary) immersionNow = h.immersion;
          let shadow: Shadow | undefined;
          for (let k = 0; k < shadows.length; k++) if (shadows[k].id === hand.id) { shadow = shadows[k]; break; }
          if (!shadow) { shadow = { id: hand.id, opacity: 0, present: true, solid: new SolidShadow() }; shadows.push(shadow); }
          shadow.present = true; shadow.opacity = approach(shadow.opacity, 1, dt, .08);
          const solid = hand.capsules.length > 0;
          if (solid) shadow.solid.setSolid(hand.capsules, aspect, level, h.x, h.y, dt); else shadow.solid.setSphere(h, aspect);
          // Each hand gets a fair share of the remaining footprint slots; the nearest to the surface come first.
          const before = footprints.count, budget = Math.max(1, Math.floor((MAX_FOOTPRINTS - before) / (handCount - i)));
          if (solid) footprints.addSolid(hand.capsules, aspect, level, h.vx, h.vy, shadow.solid.rel, budget, 1, 0);
          else footprints.addSphere(h, 1, 0);
        }
        // Pressing down on the water or lifting out of it displaces the water around every wet part; many
        // overlapping capsules share the push.
        const vertical = params.heightContact && input.primary && !scanActive ? clamp(input.primary.velocity.y, -1.5, 1.5) : 0;
        stamps.addFootprints(footprints, aspect, force, PRESS_GAIN * force * vertical / Math.sqrt(Math.max(1, footprints.count)));
        splashes.retain(seen);
        // Shadows of departed hands fade in place instead of vanishing.
        for (let i = shadows.length - 1; i >= 0; i--) {
          const sh = shadows[i];
          if (sh.present) continue;
          sh.opacity = approach(sh.opacity, 0, dt, .25);
          if (sh.opacity < .01) shadows.splice(i, 1);
        }
        immersion = immersionNow;

        // The water: a few substeps, the stamps going in with the first.
        const rows = field.height, n = substepsFor(params.speed, dt, rows), c = effectiveSpeed(params.speed, dt, rows), sub = dt / n;
        pWave.use().f2('u_texel', 1 / field.width, 1 / field.height).f1('u_dx', 1 / rows).f1('u_dt', sub).f1('u_stepDt', dt)
          .f1('u_c2', c * c).f1('u_nu', rippleViscosity(params.ripples)).f1('u_damp', Math.exp(-params.settle * sub)).f1('u_relax', Math.exp(-HEIGHT_RELAX * sub))
          .f1('u_aspect', aspect).f4v('u_seg', stamps.seg).f4v('u_vel', stamps.vel).f4v('u_meta', stamps.meta);
        for (let i = 0; i < n; i++) {
          pWave.texture('u_field', field.read.texture, 0).i1('u_stampCount', i === 0 ? stamps.count : 0);
          run(field.write); field.swap();
        }
      },

      render(frame, params) {
        const sand = hexToRgb(params.sand), water = hexToRgb(params.water);
        // Pack every hand's capsules back to back; each hand's record says where its run starts.
        let first = 0, shadowCount = 0;
        for (let i = 0; i < shadows.length && i < glsl.MAX_HANDS; i++) {
          const sh = shadows[i], solid = sh.solid, n = Math.min(solid.count, MAX_SHADOW_CAPSULES - first);
          if (n <= 0) break;
          capSeg.set(solid.seg.subarray(0, n * 4), first * 4); capMeta.set(solid.meta.subarray(0, n * 4), first * 4);
          const o = shadowCount * 4;
          shadowHands[o] = solid.cx; shadowHands[o + 1] = solid.cy; shadowHands[o + 2] = solid.bound; shadowHands[o + 3] = sh.opacity;
          shadowMeta[o] = first; shadowMeta[o + 1] = n; shadowMeta[o + 2] = 0; shadowMeta[o + 3] = 0;
          first += n; shadowCount++;
        }
        const dt = lastRenderTime < 0 ? 0 : clamp(frame.time - lastRenderTime, 0, .1);
        lastRenderTime = frame.time;
        bindScreen(gl, frame.width, frame.height);
        pComposite.use().texture('u_field', field.read.texture, 0).f2('u_texel', 1 / field.width, 1 / field.height)
          .f2('u_cell', frame.aspect / field.width, 1 / field.height)
          .f1('u_aspect', frame.aspect).f1('u_domain', domainScale(frame.aspect))
          .f1('u_depth', params.depth).f1('u_refraction', params.refraction).f1('u_caustics', params.caustics).f1('u_dispersion', params.dispersion)
          .f1('u_light', params.light).f1('u_absorb', .05 + 2.2 * (1 - params.clarity) ** 2).f1('u_texture', params.sandTexture)
          .f3('u_sand', sand[0] ** 2.2, sand[1] ** 2.2, sand[2] ** 2.2).f3('u_water', water[0] ** 2.2, water[1] ** 2.2, water[2] ** 2.2)
          .i1('u_shadowCount', shadowCount).f4v('u_shadowHands', shadowHands).f4v('u_shadowMeta', shadowMeta).f4v('u_capSeg', capSeg).f4v('u_capMeta', capMeta)
          .f4('u_scan', scan.bx, scan.by, scan.bound, scanOpacity).f4v('u_swell', swell.update(params.breeze, params.speed, dt));
        scanUniforms(pComposite, 1, scan.minY, scan.total ? Math.max(0, scan.maxY - scan.minY) + 1 / (scanTexture.height || 64) : 0, scanWet * scanOpacity);
        drawQuad(gl);

        // Signals: collect finished probe readbacks, then queue another if a slot is free.
        if (readback.collect()) measures = decodeProbe(readback.bytes);
        if (readback.free) {
          pProbe.use().texture('u_field', field.read.texture, 0).f2('u_texel', 1 / field.width, 1 / field.height).f1('u_dx', 1 / field.height);
          run(probeTarget);
          readback.request();
          bindScreen(gl, frame.width, frame.height);
        }
        smoother.update(measuresToSignals(measures, immersion), dt);
      },

      signals() { const v = smoother.values; return { energy: v.energy, sloshX: v.sloshX, sloshZ: v.sloshZ, ripple: v.ripple, calm: v.calm, immersion: v.immersion }; },

      /** The field follows the canvas shape; the water carries over, stretched onto the new grid. */
      resize() {
        const size = fieldSize(ctx.quality, ctx.aspect);
        if (size.width === field.width && size.height === field.height) return;
        const next = newField(ctx.aspect);
        next.read.bind(); blit(gl, field.read.texture);
        field.dispose(); field = next;
      },

      dispose() {
        readback.dispose();
        shadows.length = 0;
        pWave.dispose(); pProbe.dispose(); pComposite.dispose();
        scanTexture.dispose(); field.dispose(); probeTarget.dispose();
      },
    };
  },
});
