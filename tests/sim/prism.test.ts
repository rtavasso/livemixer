import { describe, expect, it } from 'vitest';
import {
  beamGain, beamWidth, CLEARANCE_MAX, idleOrbit, lightPlane, MAX_OCCLUDERS, MAX_SEGMENTS, nextRayBudget, PALM_REACH, prismCentre, prismRadius, QUALITY, rayCount,
  SCAN_THICKNESS, SCAN_TOLERANCE, TOUCH_MARGIN, TRACE_DEFAULTS, traceOptionsFor, wallOf,
} from '../../src/sim/sims/prism/config';
import {
  buildSpectrum, CAUCHY_B_GLASS, cauchyIndex, createPolygon, criticalAngle, fresnelReflectance, HIT_STRIDE, intersectPolygon, OCCLUDER_CAPSULE, OCCLUDER_QUAD,
  OCCLUDER_STRIDE, OccluderSet, pointInPolygon, rayCapsuleInPlane, rayConvexQuad, refract, reflect, SEGMENT_STRIDE, setRegularPolygon, signalsFromStats, Tracer,
  wavelengthToRgb, type BeamSource, type RawSignals, type TraceOptions,
} from '../../src/sim/sims/prism/optics';
import { addHandOccluders, addScanOccluders, pointQuadDistance, quadCorners, type Emitter } from '../../src/sim/sims/prism/solids';
import { convexHull, EYE_HEIGHT, faceBrightness, prismCamera, prismCorners, prismSilhouette } from '../../src/sim/sims/prism/geometry';
import { DEFAULT_EYE, transformPoint, windowCamera } from '../../src/sim/core/camera';
import type { SurfaceField, Vec3 } from '../../src/sim/core/types';
import type { Capsule, HandState } from '../../src/sim/input/types';
import { surfaceFromCapsules, syntheticHandCapsules } from '../../src/sim/input/synthetic';
import { IMAGE_MAPPING, mapPoint, mapSurface } from '../../src/sim/input/mapping';
import prism from '../../src/sim/sims/prism';

const deg = (d: number) => (d * Math.PI) / 180;
const angleOf = (x: number, y: number) => Math.atan2(y, x);

describe('prism surface physics', () => {
  it('refracts according to Snell', () => {
    // Surface along x, the ray arrives from above (normal points up, towards the incident side).
    const out = new Float64Array(2);
    const theta1 = deg(30);
    const cosT = refract(Math.sin(theta1), -Math.cos(theta1), 0, 1, 1 / 1.5, out);
    expect(cosT).toBeGreaterThan(0);
    const theta2 = Math.asin(out[0]);
    expect(theta2).toBeCloseTo(Math.asin(Math.sin(theta1) / 1.5), 9);
    expect(out[1]).toBeLessThan(0);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 12);
    expect(cosT).toBeCloseTo(Math.cos(theta2), 12);
  });
  it('detects total internal reflection beyond the critical angle', () => {
    const out = new Float64Array(2);
    const critical = criticalAngle(1.5, 1);
    expect(critical).toBeCloseTo(deg(41.8103), 4);
    const above = critical + deg(1), below = critical - deg(1);
    expect(refract(Math.sin(above), -Math.cos(above), 0, 1, 1.5, out)).toBe(-1);
    expect(refract(Math.sin(below), -Math.cos(below), 0, 1, 1.5, out)).toBeGreaterThan(0);
    reflect(Math.sin(above), -Math.cos(above), 0, 1, out);
    expect(out[0]).toBeCloseTo(Math.sin(above), 12); expect(out[1]).toBeCloseTo(Math.cos(above), 12);
  });
  it('Fresnel reflectance is about 4% at normal incidence for n = 1.5 and approaches 1 at grazing', () => {
    expect(fresnelReflectance(1, 1, 1, 1.5)).toBeCloseTo(.04, 6);
    const grazing = deg(89.9);
    const cosT = Math.sqrt(1 - (Math.sin(grazing) / 1.5) ** 2);
    expect(fresnelReflectance(Math.cos(grazing), cosT, 1, 1.5)).toBeGreaterThan(.98);
    // Monotonic and bounded across the range.
    let previous = 0;
    for (let a = 0; a < 90; a += 5) { const i = deg(a), t = Math.sqrt(1 - (Math.sin(i) / 1.5) ** 2); const r = fresnelReflectance(Math.cos(i), t, 1, 1.5); expect(r).toBeGreaterThanOrEqual(previous - 1e-9); expect(r).toBeLessThanOrEqual(1); previous = r; }
  });
  it('Cauchy dispersion gives a higher index for shorter wavelengths', () => {
    expect(cauchyIndex(.55, 1.5, .004)).toBeCloseTo(1.5 + .004 / .3025, 9);
    expect(cauchyIndex(.4, 1.5, .004)).toBeGreaterThan(cauchyIndex(.7, 1.5, .004));
  });
});

describe('convex polygon', () => {
  it('builds counter-clockwise regular polygons with outward normals and classifies points', () => {
    const poly = setRegularPolygon(createPolygon(), 3, 0, 0, 1, 0);
    expect(poly.count).toBe(3);
    for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; const mx = (poly.x[i] + poly.x[j]) / 2, my = (poly.y[i] + poly.y[j]) / 2; expect(mx * poly.nx[i] + my * poly.ny[i]).toBeGreaterThan(0); }
    expect(pointInPolygon(poly, 0, 0)).toBe(true); expect(pointInPolygon(poly, 2, 0)).toBe(false);
    const edge = new Int32Array(1);
    const t = intersectPolygon(poly, -3, 0, 1, 0, -1, edge);
    expect(t).toBeCloseTo(2.5, 9); expect(edge[0]).toBe(1);
    expect(intersectPolygon(poly, -3, 5, 1, 0, -1, edge)).toBe(Infinity);
    expect(intersectPolygon(poly, 0, 0, 1, 0, -1, edge)).toBeCloseTo(1, 9);
  });
});

/** Equilateral prism of circumradius 1 at the origin: edge 1 is the vertical left face, edge 0 the upper-right face. */
function minimumDeviationScene(n: number, spectrumSamples: number, cauchyB: number, bounces = 1) {
  const prism = setRegularPolygon(createPolygon(), 3, 0, 0, 1, 0);
  const theta1 = Math.asin(n * Math.sin(deg(30)));
  const entryX = -.5, entryY = -.3;
  const dirX = Math.cos(theta1), dirY = Math.sin(theta1);
  const source: BeamSource = { x: entryX - dirX, y: entryY - dirY, dirX, dirY, width: 0, intensity: 1, rays: 1, gain: 1 };
  const options: TraceOptions = { spectrum: buildSpectrum(spectrumSamples), glassA: n, glassB: cauchyB, bounces, minEnergy: 1e-5, bounds: [-6, -6, 6, 6] };
  return { prism, source, options, theta1 };
}

describe('prism ray tracer', () => {
  it('deviates a ray through an equilateral prism at minimum deviation by 2·asin(n·sin 30°) − 60°', () => {
    const { prism, source, options, theta1 } = minimumDeviationScene(1.5, 1, 0);
    const tracer = new Tracer(1000);
    tracer.trace([prism], [source], options);
    expect(tracer.exitCount).toBeGreaterThan(0);
    let best = -1, bestEnergy = 0;
    for (let i = 0; i < tracer.exitCount; i++) if (tracer.exitKind[i] >= 0 && tracer.exitEnergy[i] > bestEnergy) { best = i; bestEnergy = tracer.exitEnergy[i]; }
    expect(best).toBeGreaterThanOrEqual(0);
    const deviation = theta1 - angleOf(tracer.exitDirX[best], tracer.exitDirY[best]);
    const expected = 2 * Math.asin(1.5 * Math.sin(deg(30))) - deg(60);
    expect(expected).toBeCloseTo(deg(37.18), 3);
    expect(deviation).toBeCloseTo(expected, 5);
    // Energy bookkeeping: transmitted twice through ~48.6° interfaces.
    const cosI = Math.cos(theta1), cosT = Math.cos(deg(30));
    const r = fresnelReflectance(cosI, cosT, 1, 1.5);
    expect(bestEnergy).toBeCloseTo((1 - r) * (1 - r), 4);
    expect(tracer.stats.exitReflected).toBeGreaterThan(0);
    expect(tracer.stats.exitEnergy).toBeLessThanOrEqual(1 + 1e-9);
    expect(tracer.stats.insideSegments).toBeGreaterThan(0);
  });
  it('bends red less than blue', () => {
    const { prism, source, options, theta1 } = minimumDeviationScene(1.5, 8, .02);
    const tracer = new Tracer(1000);
    tracer.trace([prism], [source], options);
    const deviationFor = (kind: number) => {
      for (let i = 0; i < tracer.exitCount; i++) if (tracer.exitKind[i] === kind && !tracer.exitReflected[i]) return theta1 - angleOf(tracer.exitDirX[i], tracer.exitDirY[i]);
      throw new Error(`no unreflected exit for wavelength ${kind}`);
    };
    const violet = deviationFor(0), red = deviationFor(options.spectrum.count - 1);
    expect(options.spectrum.lambdaUm[0]).toBeLessThan(options.spectrum.lambdaUm[options.spectrum.count - 1]);
    expect(red).toBeLessThan(violet);
    expect(violet - red).toBeGreaterThan(deg(1));
  });
  it('is deterministic and respects the segment cap', () => {
    const a = setRegularPolygon(createPolygon(), 3, 0, 0, .3, .2), b = setRegularPolygon(createPolygon(), 3, .7, .1, .3, 1.1);
    const sources: BeamSource[] = [
      { x: -1, y: 0, dirX: 1, dirY: 0, width: .2, intensity: 1, rays: 200, gain: .01 },
      { x: 1.2, y: 1, dirX: -.7071, dirY: -.7071, width: .1, intensity: .5, rays: 100, gain: .01 },
    ];
    const options: TraceOptions = { spectrum: buildSpectrum(24), glassA: 1.52, glassB: .014, bounces: 8, minEnergy: .002 / 24, bounds: [-1.2, -1, 2, 1.5] };
    const small = new Tracer(500);
    small.trace([a, b], sources, options);
    expect(small.count).toBe(500); expect(small.stats.truncated).toBe(true);
    const one = new Tracer(60000), two = new Tracer(60000);
    one.trace([a, b], sources, options); two.trace([a, b], sources, options);
    expect(one.count).toBe(two.count);
    expect(one.stats).toEqual(two.stats);
    expect(one.count).toBeGreaterThan(1000);
    expect(one.count).toBeLessThanOrEqual(60000);
    // A plain loop: a deep-equal over half a million floats takes seconds in the test runner.
    let nonFinite = 0, mismatches = 0;
    for (let i = 0; i < one.count * SEGMENT_STRIDE; i++) { if (!Number.isFinite(one.segments[i])) nonFinite++; if (one.segments[i] !== two.segments[i]) mismatches++; }
    expect(nonFinite).toBe(0);
    expect(mismatches).toBe(0);
    // Conservation: nothing leaves with more energy than was launched.
    expect(one.stats.exitEnergy).toBeLessThanOrEqual(one.stats.launched + 1e-6);
  });
  it('reports signals within their ranges', () => {
    const out: RawSignals = { spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0, occluded: 0 };
    const { prism, source, options, theta1 } = minimumDeviationScene(1.5, 16, .014, 4);
    const tracer = new Tracer(20000);
    signalsFromStats(tracer.trace([prism], [{ ...source, width: .2, rays: 40 }], options), out);
    for (const [name, value] of Object.entries(out)) { expect(value, name).toBeGreaterThanOrEqual(0); expect(value, name).toBeLessThanOrEqual(1); }
    expect(out.incidence).toBeCloseTo(theta1 / (Math.PI / 2), 2);
    expect(out.inside).toBeGreaterThan(0); expect(out.reflected).toBeGreaterThan(0); expect(out.spread).toBeGreaterThan(0);
    // A beam that misses everything stays parallel and unreflected.
    const miss = signalsFromStats(tracer.trace([prism], [{ ...source, y: 4, dirX: 1, dirY: 0, width: .2, rays: 40 }], options), out);
    expect(miss.spread).toBeCloseTo(0, 6); expect(miss.reflected).toBe(0); expect(miss.inside).toBe(0); expect(miss.brightness).toBeCloseTo(1, 6);
  });
});

describe('wavelength interleaving', () => {
  it('spreads a fine wavelength table across neighbouring rays and stays deterministic', () => {
    // Minimum-deviation geometry (normal incidence would meet the second face at 60° and reflect totally).
    const { prism, source: narrow } = minimumDeviationScene(1.5, 1, 0);
    const source: BeamSource = { ...narrow, width: .3, rays: 8 };
    const spectrum = buildSpectrum(32);
    const options: TraceOptions = { spectrum, samplesPerRay: 8, glassA: 1.5, glassB: .01, bounces: 1, minEnergy: 1e-5, bounds: [-6, -6, 6, 6] };
    const tracer = new Tracer(5000);
    tracer.trace([prism], [source], options);
    const seen = new Set<number>();
    for (let i = 0; i < tracer.exitCount; i++) if (tracer.exitKind[i] >= 0) seen.add(tracer.exitKind[i]);
    expect(seen.size).toBe(32);
    // Each ray carries exactly 8 of the 32 samples and the per-ray energy is still 1/8 each.
    const first = new Tracer(5000); first.trace([prism], [{ ...source, rays: 1, width: 0 }], options);
    const kinds = new Set<number>(); for (let i = 0; i < first.exitCount; i++) if (first.exitKind[i] >= 0) kinds.add(first.exitKind[i]);
    expect(kinds.size).toBe(8);
    expect(first.stats.exitEnergy).toBeLessThanOrEqual(1 + 1e-9);
    expect(first.stats.exitEnergy).toBeGreaterThan(.8);
    const twice = new Tracer(5000); twice.trace([prism], [source], options);
    expect(twice.stats).toEqual(tracer.stats);
    // Signals: a complete spectrum sits near the middle hue; cutting the blue end (index 0..15) would pull it towards red.
    const out: RawSignals = { spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0, occluded: 0 };
    signalsFromStats(tracer.stats, out);
    expect(out.hue).toBeGreaterThan(.15); expect(out.hue).toBeLessThan(.5);
    const focused = tracer.signals({ ...out });
    expect(focused.hue).toBeGreaterThanOrEqual(0); expect(focused.hue).toBeLessThanOrEqual(1);
    expect(Math.abs(focused.hue - out.hue)).toBeLessThan(.2);
  });
});

const ASPECT = 16 / 9, DEPTH = 1;

/**
 * The simulation's own scene at a quality tier: the prism where `index.ts` puts it in the light plane, the beam
 * launched from a point on the idle orbit aimed at the prism's axis, sized and normalised exactly as `traceScene`
 * does it. The tracer's y is the volume's z.
 */
function simulationScene(quality: keyof typeof QUALITY, overrides: Partial<{ rays: number; bounces: number; openness: number; dispersion: number; size: number; glass: number; beam: number }> = {}, aspect = ASPECT, depth = DEPTH) {
  const tier = QUALITY[quality];
  const p = { openness: .5, ...TRACE_DEFAULTS, ...overrides };
  const sceneHeight = Math.round(900 * tier.sceneScale);
  const centre = { x: 0, z: 0 }; prismCentre(0, false, aspect, depth, centre);
  const polygon = setRegularPolygon(createPolygon(8), 3, centre.x, centre.z, prismRadius(p.size, aspect, depth), .3);
  const options = traceOptionsFor(tier, buildSpectrum(tier.spectrum * tier.interleave), p, aspect, depth, CAUCHY_B_GLASS);
  const rays = rayCount(p.rays, tier);
  const width = beamWidth(p.beam, p.openness);
  const beamAt = (angle: number): BeamSource => {
    const at = idleOrbit(angle, 0, aspect, depth, { x: 0, z: 0 });
    let dx = centre.x - at.x, dz = centre.z - at.z; const len = Math.hypot(dx, dz); dx /= len; dz /= len;
    return { x: at.x, y: at.z, dirX: dx, dirY: dz, width, intensity: 1, rays, gain: beamGain(width, sceneHeight, rays) };
  };
  return { tier, polygon, centre, options, rays, beamAt };
}

const ORBIT = 24;
const orbit = Array.from({ length: ORBIT }, (_, i) => (i / ORBIT) * Math.PI * 2);

describe('the light plane', () => {
  it('maps a hand in sim space onto the tracer\'s plane: x scaled by the aspect, sim z as the plane\'s depth, y as the elevation', () => {
    const out = lightPlane({ x: .25, y: .6, z: .75 }, ASPECT, 1.5, { x: 0, y: 0, z: 0 });
    expect(out.x).toBeCloseTo(.25 * ASPECT, 12); expect(out.z).toBeCloseTo(1.125, 12); expect(out.y).toBe(.6);
    // Corners of sim space land on the walls of the volume.
    expect(lightPlane({ x: 0, y: 0, z: 0 }, ASPECT, 1.5, { x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(lightPlane({ x: 1, y: 1, z: 1 }, ASPECT, 1.5, { x: 0, y: 0, z: 0 })).toEqual({ x: ASPECT, y: 1, z: 1.5 });
  });
  it('pushing in walks the source from in front of the prism to behind it', () => {
    const centre = { x: 0, z: 0 }; prismCentre(0, false, ASPECT, DEPTH, centre);
    const front = lightPlane({ x: .5, y: .5, z: .1 }, ASPECT, DEPTH, { x: 0, y: 0, z: 0 });
    const back = lightPlane({ x: .5, y: .5, z: .9 }, ASPECT, DEPTH, { x: 0, y: 0, z: 0 });
    expect(front.x).toBeCloseTo(centre.x, 12); expect(front.z).toBeLessThan(centre.z); expect(back.z).toBeGreaterThan(centre.z);
  });
  it('the prism stands in the middle of the volume and stays inside it', () => {
    const c = { x: 0, z: 0 };
    prismCentre(0, false, ASPECT, 1.5, c); expect(c).toEqual({ x: ASPECT / 2, z: .75 });
    prismCentre(0, true, ASPECT, 1, c); expect(c.x).toBeLessThan(ASPECT / 2);
    prismCentre(1, true, ASPECT, 1, c); expect(c.x).toBeGreaterThan(ASPECT / 2); expect(c.z).toBeGreaterThan(.5);
    expect(prismRadius(.45, ASPECT, 1)).toBe(.42); expect(prismRadius(.2, ASPECT, .25)).toBeCloseTo(.105, 9); expect(prismRadius(.2, ASPECT, 1)).toBe(.2);
  });
  it('the idle orbit circles the prism inside the volume', () => {
    for (const angle of orbit) for (const t of [0, 5, 11]) {
      const at = idleOrbit(angle, t, ASPECT, DEPTH, { x: 0, z: 0 });
      expect(at.x).toBeGreaterThan(0); expect(at.x).toBeLessThan(ASPECT); expect(at.z).toBeGreaterThan(0); expect(at.z).toBeLessThan(DEPTH);
      expect(Math.hypot(at.x - ASPECT / 2, at.z - DEPTH / 2)).toBeGreaterThan(prismRadius(TRACE_DEFAULTS.size, ASPECT, DEPTH) * 1.5);
    }
  });
  it('an open hand widens the beam, a fist narrows it', () => {
    expect(beamWidth(.03, 1)).toBeCloseTo(.03, 12); expect(beamWidth(.03, 0)).toBeCloseTo(.0105, 12);
    expect(beamWidth(.03, .5)).toBeGreaterThan(beamWidth(.03, 0)); expect(beamWidth(.03, 2)).toBe(beamWidth(.03, 1));
  });
});

describe('wall termination', () => {
  it('classifies the walls of the volume', () => {
    expect(wallOf(0, .5, ASPECT, DEPTH)).toBe(1); expect(wallOf(ASPECT, .5, ASPECT, DEPTH)).toBe(2);
    expect(wallOf(.5, 0, ASPECT, DEPTH)).toBe(3); expect(wallOf(.5, DEPTH, ASPECT, DEPTH)).toBe(4);
    expect(wallOf(.5, .5, ASPECT, DEPTH)).toBe(0); expect(wallOf(.001, .5, ASPECT, DEPTH)).toBe(0);
  });
  it('every ray that leaves the glass ends on a wall of the volume, never short of it or beyond', () => {
    const scene = simulationScene('medium');
    expect(scene.options.bounds).toEqual([0, 0, ASPECT, DEPTH]);
    // Largest signed distance to an edge line: ~0 on the glass surface (the segments are float32), negative inside, positive outside.
    const glassDistance = (x: number, z: number) => { let d = -Infinity; for (let e = 0; e < scene.polygon.count; e++) d = Math.max(d, (x - scene.polygon.x[e]) * scene.polygon.nx[e] + (z - scene.polygon.y[e]) * scene.polygon.ny[e]); return d; };
    const tracer = new Tracer(MAX_SEGMENTS);
    for (const angle of orbit) {
      const stats = tracer.trace([scene.polygon], [scene.beamAt(angle)], scene.options);
      expect(stats.exitEnergy).toBeGreaterThan(0);
      // Plain loops and counters: an expect per segment would be several hundred thousand assertions.
      let onWalls = 0, onGlass = 0, outside = 0;
      for (let i = 0; i < stats.segments; i++) {
        const o = i * SEGMENT_STRIDE, x1 = tracer.segments[o + 2], z1 = tracer.segments[o + 3];
        if (x1 < -1e-6 || x1 > ASPECT + 1e-6 || z1 < -1e-6 || z1 > DEPTH + 1e-6) outside++;
        if (wallOf(x1, z1, ASPECT, DEPTH) > 0) onWalls++;
        else if (Math.abs(glassDistance(x1, z1)) < 1e-5) onGlass++;
      }
      // Every segment ends either on a wall or on the glass, none beyond the walls; the wall-enders are the exits.
      expect(outside, `segments beyond the walls at ${Math.round(angle * 180 / Math.PI)}°`).toBe(0);
      expect(onWalls + onGlass, `segments accounted for at ${Math.round(angle * 180 / Math.PI)}°`).toBe(stats.segments);
      expect(onWalls, `wall exits at ${Math.round(angle * 180 / Math.PI)}°`).toBeGreaterThan(0);
      expect(onGlass, `glass hits at ${Math.round(angle * 180 / Math.PI)}°`).toBeGreaterThan(0);
    }
  });
  it('a beam over the glass (no polygons) runs straight from the source to the far wall', () => {
    const scene = simulationScene('medium');
    const tracer = new Tracer(MAX_SEGMENTS);
    const beam = scene.beamAt(Math.PI * 1.5); // in front of the prism, aimed at the back
    const stats = tracer.trace([], [beam], scene.options);
    expect(stats.segments).toBe(scene.rays); expect(stats.insideSegments).toBe(0);
    for (let i = 0; i < stats.segments; i++) expect(wallOf(tracer.segments[i * SEGMENT_STRIDE + 2], tracer.segments[i * SEGMENT_STRIDE + 3], ASPECT, DEPTH)).toBe(4);
    const out: RawSignals = { spread: 0, hue: .3, brightness: 0, reflected: 0, incidence: 0, inside: 0, occluded: 0 };
    signalsFromStats(stats, out);
    expect(out.incidence).toBe(0); expect(out.inside).toBe(0); expect(out.brightness).toBeCloseTo(1, 6);
  });
});

describe('the standing prism', () => {
  const aspect = ASPECT, depth = DEPTH;
  const camera = prismCamera(aspect, depth);
  it('the raised window camera keeps the front face on the screen and lifts deeper points up and in', () => {
    for (const [x, y, ex, ey] of [[0, 0, -1, -1], [aspect, 1, 1, 1], [aspect / 2, .5, 0, 0]] as const) {
      const p = camera.project({ x, y, z: 0 });
      expect(p.x).toBeCloseTo(ex, 9); expect(p.y).toBeCloseTo(ey, 9); expect(p.scale).toBe(1);
    }
    const front = camera.project({ x: aspect / 2, y: .5, z: 0 }), back = camera.project({ x: aspect / 2, y: .5, z: depth });
    expect(back.y).toBeGreaterThan(front.y);                       // the light plane at mid height is seen from above, not edge-on
    expect(camera.project({ x: aspect, y: .5, z: depth }).x).toBeCloseTo(DEFAULT_EYE / (DEFAULT_EYE + depth), 9);
    expect(camera.scale(depth)).toBeCloseTo(DEFAULT_EYE / (DEFAULT_EYE + depth), 9);
    // With the eye at mid height it is the shared window camera.
    const flat = prismCamera(aspect, depth, DEFAULT_EYE, .5), shared = windowCamera(aspect, depth);
    for (const p of [{ x: .3, y: .8, z: .2 }, { x: 1.5, y: .1, z: .9 }]) { const a = flat.project(p), b = shared.project(p); expect(a.x).toBeCloseTo(b.x, 12); expect(a.y).toBeCloseTo(b.y, 12); }
    expect(EYE_HEIGHT).toBeGreaterThan(1);
  });
  it('the matrix agrees with project() after the perspective divide', () => {
    for (const p of [{ x: .3, y: .8, z: .2 }, { x: 1.5, y: .1, z: .9 }, { x: 0, y: 0, z: 0 }, { x: aspect / 2, y: 0, z: depth }]) {
      const c = transformPoint(camera.matrix, p), q = camera.project(p);
      expect(c.x / c.w).toBeCloseTo(q.x, 5); expect(c.y / c.w).toBeCloseTo(q.y, 5); expect(c.z / c.w).toBeCloseTo(q.ndcZ, 5); expect(c.w).toBeCloseTo(p.z + DEFAULT_EYE, 5);
    }
  });
  it('corners stand on the floor above the tracer\'s polygon and the silhouette hulls them all', () => {
    const centre = { x: 0, z: 0 }; prismCentre(0, false, aspect, depth, centre);
    const polygon = setRegularPolygon(createPolygon(8), 3, centre.x, centre.z, .2, .3);
    const corners = new Float64Array(18);
    prismCorners(centre.x, centre.z, .2, .3, .7, corners);
    for (let i = 0; i < 3; i++) {
      expect(corners[i * 3]).toBeCloseTo(polygon.x[i], 12); expect(corners[i * 3 + 2]).toBeCloseTo(polygon.y[i], 12); expect(corners[i * 3 + 1]).toBe(0);
      expect(corners[9 + i * 3]).toBeCloseTo(polygon.x[i], 12); expect(corners[9 + i * 3 + 1]).toBe(.7);
    }
    const hull = new Float32Array(16);
    const count = prismSilhouette(camera, corners, hull, 0);
    expect(count).toBeGreaterThanOrEqual(3); expect(count).toBeLessThanOrEqual(6);
    // Every projected corner lies inside or on the hull (all cross products of a counter-clockwise polygon non-negative).
    for (let i = 0; i < 6; i++) {
      const p = camera.project({ x: corners[i * 3], y: corners[i * 3 + 1], z: corners[i * 3 + 2] });
      const px = (p.x * .5 + .5) * aspect, py = p.y * .5 + .5;
      expect(px).toBeGreaterThan(0); expect(px).toBeLessThan(aspect); expect(py).toBeGreaterThan(0); expect(py).toBeLessThan(1);
      for (let e = 0; e < count; e++) {
        const f = (e + 1) % count, ax = hull[e * 2], ay = hull[e * 2 + 1], bx = hull[f * 2], by = hull[f * 2 + 1];
        expect((bx - ax) * (py - ay) - (by - ay) * (px - ax)).toBeGreaterThanOrEqual(-1e-6);
      }
    }
    // A flat prism's silhouette is its own triangle.
    prismCorners(centre.x, centre.z, .2, .3, 0, corners);
    expect(prismSilhouette(camera, corners, hull, 0)).toBe(3);
  });
  it('convex hull drops interior and collinear points and runs counter-clockwise', () => {
    const out = new Float64Array(20);
    expect(convexHull([0, 0, 1, 0, 1, 1, 0, 1, .5, .5, .5, 0], 6, out)).toBe(4);
    let area = 0;
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; area += out[i * 2] * out[j * 2 + 1] - out[j * 2] * out[i * 2 + 1]; }
    expect(area).toBeCloseTo(2, 12);
    expect(convexHull([0, 0, 1, 1, 2, 2], 3, out)).toBe(2);
    expect(convexHull([3, 4], 1, out)).toBe(1);
  });
  it('faces brighten as they turn edge-on and never go dark', () => {
    expect(faceBrightness(0, 0, -1, 0, 0, -1, .01, .08)).toBeCloseTo(.01, 12);
    expect(faceBrightness(1, 0, 0, 0, 0, -1, .01, .08)).toBeCloseTo(.09, 12);
    expect(faceBrightness(0, 1, 0, 0, .5, -.866, .01, .08)).toBeGreaterThan(.01);
  });
});

describe('segment budget', () => {
  it('the simulation\'s own high-quality defaults never approach the segment cap anywhere on the idle orbit', () => {
    const scene = simulationScene('high');
    expect(scene.tier.spectrum).toBe(24); expect(scene.options.bounces).toBe(4);
    expect(scene.rays).toBeGreaterThanOrEqual(80);
    const tracer = new Tracer(MAX_SEGMENTS);
    for (const angle of orbit) {
      const stats = tracer.trace([scene.polygon], [scene.beamAt(angle)], scene.options);
      expect(stats.truncated, `truncated at ${Math.round(angle * 180 / Math.PI)}°`).toBe(false);
      expect(stats.segments, `segments at ${Math.round(angle * 180 / Math.PI)}°`).toBeLessThan(MAX_SEGMENTS * .75);
      expect(stats.rays).toBe(scene.rays);
    }
  });
  it('keeps a margin with 108 rays, a fully open hand and the widest dispersion at high quality, in a deep volume too', () => {
    for (const overrides of [{ rays: 108 / QUALITY.high.rayScale, openness: 1 }, { rays: 108 / QUALITY.high.rayScale, openness: 1, dispersion: 12 }, { rays: 160, openness: 1 }]) {
      for (const depth of [1, 3]) {
        const scene = simulationScene('high', overrides, ASPECT, depth);
        expect(scene.rays).toBeGreaterThanOrEqual(108);
        const tracer = new Tracer(MAX_SEGMENTS);
        for (const angle of orbit) {
          const stats = tracer.trace([scene.polygon], [scene.beamAt(angle)], scene.options);
          expect(stats.truncated, `truncated at ${Math.round(angle * 180 / Math.PI)}° with ${JSON.stringify(overrides)} depth ${depth}`).toBe(false);
          expect(stats.segments, `segments at ${Math.round(angle * 180 / Math.PI)}° with ${JSON.stringify(overrides)} depth ${depth}`).toBeLessThan(MAX_SEGMENTS * .75);
        }
      }
    }
  });
  it('dropping second-order reflections keeps most of the launched energy', () => {
    const scene = simulationScene('high');
    const tracer = new Tracer(MAX_SEGMENTS);
    const out: RawSignals = { spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0, occluded: 0 };
    for (const angle of orbit) {
      signalsFromStats(tracer.trace([scene.polygon], [scene.beamAt(angle)], scene.options), out);
      expect(out.brightness, `brightness at ${Math.round(angle * 180 / Math.PI)}°`).toBeGreaterThan(.85);
    }
  });
  it('a truncated trace thins the whole beam rather than dropping one side of it', () => {
    const scene = simulationScene('high', { openness: 1 });
    const beam = scene.beamAt(Math.PI * .8);
    const full = new Tracer(MAX_SEGMENTS).trace([scene.polygon], [beam], scene.options);
    expect(full.truncated).toBe(false);
    const tracer = new Tracer(Math.floor(full.segments / 5));
    const stats = tracer.trace([scene.polygon], [beam], scene.options);
    expect(stats.truncated).toBe(true);
    expect(stats.rays).toBeLessThan(scene.rays / 2);
    // Offsets across the beam of the rays that were launched: each ray's first segment starts on the source line.
    const px = -beam.dirY, py = beam.dirX;
    const offsets: number[] = [];
    for (let i = 0; i < stats.segments; i++) {
      const o = i * SEGMENT_STRIDE, dx = tracer.segments[o] - beam.x, dy = tracer.segments[o + 1] - beam.y;
      if (Math.abs(dx * beam.dirX + dy * beam.dirY) < 1e-6) offsets.push((dx * px + dy * py) / beam.width);
    }
    expect(offsets.length).toBe(stats.rays);
    offsets.sort((a, b) => a - b);
    expect(offsets[0]).toBeLessThan(-.4); expect(offsets[offsets.length - 1]).toBeGreaterThan(.4);
    let largestGap = 0;
    for (let i = 1; i < offsets.length; i++) largestGap = Math.max(largestGap, offsets[i] - offsets[i - 1]);
    expect(largestGap).toBeLessThan(4 / offsets.length);
    // Same segments as a full trace, only fewer of them: the interleaved order changes nothing that is drawn.
    const twice = new Tracer(MAX_SEGMENTS).trace([scene.polygon], [beam], scene.options);
    expect(twice).toEqual(full);
  });
  it('the ray budget backs off on truncation and recovers slowly', () => {
    let budget = 1;
    budget = nextRayBudget(budget, true); expect(budget).toBeCloseTo(.85, 9);
    for (let i = 0; i < 100; i++) budget = nextRayBudget(budget, true);
    expect(budget).toBe(.25);
    let frames = 0;
    while (budget < 1) { budget = nextRayBudget(budget, false); frames++; }
    expect(budget).toBe(1); expect(frames).toBe(75);
    expect(rayCount(72, QUALITY.high, .25)).toBeGreaterThanOrEqual(4);
    expect(rayCount(8, QUALITY.low, .25)).toBe(4);
  });
});

/** A tracked hand in sim space with a solid shape. */
function handState(id: number, position: Vec3, capsules: Capsule[]): HandState {
  return { id, position, velocity: { x: 0, y: 0, z: 0 }, speed: 0, extent: { min: position, max: position }, radius: .05, openness: 1, pinch: 0, confidence: 1, ageMs: 0, staleMs: 0, push: position.z, points: [], capsules };
}
const emptySignals = (): RawSignals => ({ spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0, occluded: 0 });
const noGlass: TraceOptions = { spectrum: buildSpectrum(8), glassA: 1.5, glassB: 0, bounces: 2, minEnergy: 1e-6, bounds: [-1, -1, 3, 1] };

describe('solids in the light plane', () => {
  it('slices a capsule by the plane exactly: a vertical bone is a disc of its radius, a bone passing above the plane a sphere slice', () => {
    const r = .1;
    // A vertical bone at x = 1 through the plane h = .5: rays across it (along x, at lateral offset y) meet a disc of radius r.
    const vertical = (offset: number) => rayCapsuleInPlane(0, .5, offset, 1, 0, 1, 0, 0, 1, 1, 0, r);
    expect(vertical(0)).toBeCloseTo(1 - r, 9);
    expect(vertical(r - 1e-4)).toBeLessThan(Infinity); expect(vertical(r + 1e-4)).toBe(Infinity);
    // A bone lying along the tracer's y at x = 1, its axis dy above the plane: the cross-section radius is sqrt(r² − dy²).
    for (const dy of [0, .03, .06, .0999]) {
      const slice = Math.sqrt(r * r - dy * dy);
      expect(rayCapsuleInPlane(0, .5, 0, 1, 0, 1, .5 + dy, -1, 1, .5 + dy, 1, r)).toBeCloseTo(1 - slice, 9);
    }
    expect(rayCapsuleInPlane(0, .5, 0, 1, 0, 1, .5 + r + 1e-4, -1, 1, .5 + r + 1e-4, 1, r)).toBe(Infinity);
    // A ray starting inside passes through; a ray along a bone's axis enters its near cap; one beside it misses.
    expect(rayCapsuleInPlane(1, .5, 0, 1, 0, 1, 0, 0, 1, 1, 0, r)).toBe(Infinity);
    expect(rayCapsuleInPlane(0, .5, 0, 1, 0, 1, .5, 0, 2, .5, 0, r)).toBeCloseTo(1 - r, 9);
    expect(rayCapsuleInPlane(0, .5, r + .01, 1, 0, 1, .5, 0, 2, .5, 0, r)).toBe(Infinity);
    // A sphere (zero-length capsule) behaves like its end caps.
    expect(rayCapsuleInPlane(0, .5, 0, 1, 0, 1, .5, 0, 1, .5, 0, r)).toBeCloseTo(1 - r, 9);
  });
  it('enters a convex quad through the nearest edge and passes through when starting inside', () => {
    const d = new Float64Array([1, -.5, 2, -.5, 2, .5, 1, .5]), edge = new Int32Array(1);
    expect(rayConvexQuad(0, 0, 1, 0, d, 0, edge)).toBeCloseTo(1, 12); expect(edge[0]).toBe(3);      // the left edge
    expect(rayConvexQuad(1.5, -2, 0, 1, d, 0, edge)).toBeCloseTo(1.5, 12); expect(edge[0]).toBe(0);  // the bottom edge
    expect(rayConvexQuad(0, 1, 1, 0, d, 0, edge)).toBe(Infinity);                                     // beside it
    expect(rayConvexQuad(1.5, 0, 1, 0, d, 0, edge)).toBe(Infinity);                                   // inside
    expect(rayConvexQuad(3, 0, 1, 0, d, 0, edge)).toBe(Infinity);                                     // behind
    expect(pointQuadDistance(1.5, 0, d)).toBeCloseTo(-.5, 12); expect(pointQuadDistance(0, 0, d)).toBeCloseTo(1, 12); expect(pointQuadDistance(0, 1, d)).toBeCloseTo(Math.hypot(1, .5), 9);
  });
  it('keeps only the capsules that reach the plane and bounds each body with a disc around its slices', () => {
    const occ = new OccluderSet(8, 2);
    occ.begin(.5);
    occ.beginGroup();
    expect(occ.addCapsule(0, .8, 0, 1, .9, 0, .1)).toBe(false);      // entirely above the plane
    expect(occ.addCapsule(0, .61, 0, 1, .61, 0, .1)).toBe(false);    // axis .11 above with radius .1: out of reach
    expect(occ.addCapsule(0, .55, 0, 1, .55, 0, .1)).toBe(true);     // within reach
    expect(occ.addCapsule(2, .2, .3, 2, .9, .3, .05)).toBe(true);    // crosses the plane
    occ.endGroup();
    occ.beginGroup(); expect(occ.addCapsule(5, 2, 5, 6, 2, 5, .1)).toBe(false); occ.endGroup();   // nothing in the plane: no group
    expect(occ.count).toBe(2); expect(occ.groupCount).toBe(1); expect(occ.kind[0]).toBe(OCCLUDER_CAPSULE);
    const [cx, cy, cr] = occ.disc(0);
    // Every point on either slice's boundary lies within the disc: cast rays at the slices from all around.
    let boundaryPoints = 0;
    for (let a = 0; a < 36; a++) {
      const dx = Math.cos((a / 36) * Math.PI * 2), dy = Math.sin((a / 36) * Math.PI * 2), ox = cx - dx * 10, oy = cy - dy * 10;
      for (let k = 0; k < occ.count; k++) {
        const o = k * OCCLUDER_STRIDE, d = occ.data;
        const t = rayCapsuleInPlane(ox, .5, oy, dx, dy, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6]);
        if (t === Infinity) continue;
        boundaryPoints++;
        expect(Math.hypot(ox + dx * t - cx, oy + dy * t - cy)).toBeLessThanOrEqual(cr + 1e-9);
      }
    }
    expect(boundaryPoints).toBeGreaterThan(20);
    // The cap: the 9th capsule of an 8-capsule set is refused.
    occ.begin(.5); occ.beginGroup();
    for (let i = 0; i < 9; i++) expect(occ.addCapsule(i, .5, 0, i, .5, 1, .1)).toBe(i < 8);
    occ.endGroup();
    expect(occ.full).toBe(true); expect(MAX_OCCLUDERS).toBe(48);
  });
  it('a body across the beam stops every ray, absorbs its energy, and leaves a splash whose normal faces the light', () => {
    const occ = new OccluderSet();
    occ.begin(.5); occ.beginGroup(); occ.addCapsule(1, .5, -1, 1, .5, 1, .15); occ.endGroup();   // a bone lying across the beam at x = 1
    const beam: BeamSource = { x: 0, y: 0, dirX: 1, dirY: 0, width: .2, intensity: 1, rays: 16, gain: 1 };
    const tracer = new Tracer(1000);
    const stats = tracer.trace([], [beam], noGlass, occ);
    expect(stats.rays).toBe(16); expect(stats.occludedRays).toBe(16); expect(stats.exitEnergy).toBe(0);
    expect(stats.occluded).toBeCloseTo(stats.launched, 9);
    expect(stats.segments).toBe(16); expect(tracer.hitCount).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(tracer.segments[i * SEGMENT_STRIDE + 2]).toBeCloseTo(.85, 5);   // ends on the bone's near surface
      const h = i * HIT_STRIDE;
      expect(tracer.hits[h]).toBeCloseTo(.85, 5); expect(tracer.hits[h + 2]).toBeCloseTo(-1, 5); expect(tracer.hits[h + 3]).toBeCloseTo(0, 5);
      expect(tracer.hits[h + 8]).toBeCloseTo(.5, 6); expect(tracer.hits[h + 9]).toBeCloseTo(0, 5);
      for (let c = 4; c < 7; c++) expect(tracer.hits[h + c]).toBeCloseTo(1, 4);  // white light lands white; the tint is the renderer's
      expect(tracer.hits[h + 7]).toBeCloseTo(tracer.segments[i * SEGMENT_STRIDE + 7], 6);
    }
    const out = signalsFromStats(stats, emptySignals());
    expect(out.occluded).toBe(1); expect(out.brightness).toBe(0);
    // Half the beam covered: what leaves and what is stopped add up to what was launched.
    occ.begin(.5); occ.beginGroup(); occ.addCapsule(1, .5, .02, 1, .5, 1, .02); occ.endGroup();
    const half = tracer.trace([], [beam], noGlass, occ);
    expect(half.occludedRays).toBe(8); expect(half.occluded + half.exitEnergy).toBeCloseTo(half.launched, 9);
    expect(signalsFromStats(half, emptySignals()).occluded).toBeCloseTo(.5, 6);
    // No occluders at all: nothing changes.
    const clear = tracer.trace([], [beam], noGlass, null);
    expect(clear.occluded).toBe(0); expect(clear.occludedRays).toBe(0); expect(tracer.hitCount).toBe(0); expect(clear.exitEnergy).toBeCloseTo(clear.launched, 9);
  });
  it('the hand the beam leaves from does not stop its own light, while a finger farther out still shades it', () => {
    const aspect = ASPECT, depth = DEPTH, palm = { x: .5, y: .5, z: .3 };
    const capsules = syntheticHandCapsules(palm, 1, .05);
    const hand = handState(1, palm, capsules);
    const px = palm.x * aspect, pz = palm.z * depth, width = beamWidth(TRACE_DEFAULTS.beam, 1);
    const beamFrom = (dirX: number, dirY: number): BeamSource => ({ x: px, y: pz, dirX, dirY, width, intensity: 1, rays: 24, gain: 1, clearance: { x: px, y: pz, radius: 0 } });
    const options = traceOptionsFor(QUALITY.medium, buildSpectrum(64), TRACE_DEFAULTS, aspect, depth, CAUCHY_B_GLASS);
    const tracer = new Tracer(MAX_SEGMENTS), occ = new OccluderSet();
    // Without an emitter, the palm's own bones stop the beam at once.
    occ.begin(palm.y, px, pz); addHandOccluders(occ, hand, aspect, depth, null);
    expect(occ.count).toBeGreaterThanOrEqual(4); expect(occ.groupCount).toBe(1); expect(occ.palmReach).toBe(0);
    const blocked = tracer.trace([], [beamFrom(-1, 0)], options, occ);
    expect(blocked.occluded / blocked.launched).toBeGreaterThan(.5);
    // With the hand as the emitter the beam leaves freely, its rays starting on the clearance disc rather than in the palm.
    const emitter: Emitter = { x: px, y: palm.y, z: pz, reach: PALM_REACH, touch: width / 2 + TOUCH_MARGIN };
    occ.begin(palm.y, px, pz); addHandOccluders(occ, hand, aspect, depth, emitter);
    expect(occ.palmReach).toBeGreaterThan(.02); expect(occ.palmReach).toBeLessThan(PALM_REACH);
    let emitters = 0; for (let k = 0; k < occ.count; k++) emitters += occ.emitter[k];
    expect(emitters).toBeGreaterThanOrEqual(4);
    const beam = beamFrom(-1, 0); beam.clearance!.radius = Math.min(CLEARANCE_MAX, occ.palmReach);
    const free = tracer.trace([], [beam], options, occ);
    expect(free.occluded).toBe(0); expect(free.occludedRays).toBe(0); expect(free.exitEnergy).toBeCloseTo(free.launched, 9);
    for (let i = 0; i < free.segments; i++) {
      const o = i * SEGMENT_STRIDE;
      expect(Math.hypot(tracer.segments[o] - px, tracer.segments[o + 1] - pz)).toBeCloseTo(beam.clearance!.radius, 4);
      expect(tracer.segments[o]).toBeLessThan(px);
    }
    // The same rays without the clearance disc still pass: the emitter is skipped by a first segment wherever it starts.
    const clearance = beamFrom(-1, 0);
    expect(tracer.trace([], [clearance], options, occ).occluded).toBe(0);
    // A finger of the same hand farther out than a palm's reach, lying in the beam's path, shades it.
    const finger: Capsule = { a: { x: palm.x - .2 / aspect, y: palm.y - .01, z: palm.z }, b: { x: palm.x - .26 / aspect, y: palm.y + .01, z: palm.z }, radius: .012 };
    occ.begin(palm.y, px, pz); addHandOccluders(occ, handState(1, palm, [...capsules, finger]), aspect, depth, emitter);
    const shaded = tracer.trace([], [beam], options, occ);
    expect(shaded.occluded / shaded.launched).toBeGreaterThan(.9);
    expect(tracer.hitCount).toBe(shaded.occludedRays);
    // The finger lies nearly in the plane, so its slice is a stadium: every hit is on the near cap, within a radius of its end.
    for (let i = 0; i < tracer.hitCount; i++) { const x = tracer.hits[i * HIT_STRIDE]; expect(x).toBeGreaterThan(px - .2 - 1e-6); expect(x).toBeLessThan(px - .2 + .012 * aspect + 1e-6); }
  });
  it('is deterministic with solids in the plane', () => {
    const aspect = ASPECT, depth = DEPTH, palm = { x: .3, y: .5, z: .3 };
    const scene = simulationScene('medium');
    const hands = [handState(1, palm, syntheticHandCapsules(palm, .7, .06)), handState(2, { x: .6, y: .5, z: .7 }, syntheticHandCapsules({ x: .6, y: .5, z: .7 }, 1, .05, true))];
    const run = () => {
      const occ = new OccluderSet(), tracer = new Tracer(MAX_SEGMENTS);
      occ.begin(.5, palm.x * aspect, palm.z * depth);
      for (const h of hands) addHandOccluders(occ, h, aspect, depth, h.id === 1 ? { x: palm.x * aspect, y: .5, z: palm.z * depth, reach: PALM_REACH, touch: .02 } : null);
      const beam = scene.beamAt(Math.PI * 1.2); beam.clearance = { x: palm.x * aspect, y: palm.z * depth, radius: Math.min(CLEARANCE_MAX, occ.palmReach) };
      const stats = { ...tracer.trace([scene.polygon], [beam], scene.options, occ) };
      return { stats, segments: tracer.segments.slice(0, stats.segments * SEGMENT_STRIDE), hits: tracer.hits.slice(0, tracer.hitCount * HIT_STRIDE), occluders: occ.count, groups: occ.groupCount };
    };
    const a = run(), b = run();
    expect(a.occluders).toBeGreaterThan(0); expect(a.groups).toBe(2);
    expect(a.stats).toEqual(b.stats);
    expect(a.segments).toEqual(b.segments); expect(a.hits).toEqual(b.hits);
  });
  it('a body behind the prism catches part of the fan and the energy stays accounted for', () => {
    const scene = simulationScene('medium');
    const occ = new OccluderSet(), tracer = new Tracer(MAX_SEGMENTS);
    occ.begin(.5); occ.beginGroup(); occ.addCapsule(.3 * ASPECT, .5, .85 * DEPTH, .7 * ASPECT, .5, .85 * DEPTH, .04); occ.endGroup();
    const beam = scene.beamAt(Math.PI * 1.5);
    const stats = tracer.trace([scene.polygon], [beam], scene.options, occ);
    expect(stats.occluded).toBeGreaterThan(0); expect(stats.occluded).toBeLessThan(stats.launched);
    expect(stats.exitEnergy + stats.occluded).toBeLessThanOrEqual(stats.launched + 1e-6);
    expect(tracer.hitCount).toBe(stats.occludedRays);
    // Dispersed light lands in colour: the hits are not all white.
    let coloured = 0;
    for (let i = 0; i < tracer.hitCount; i++) { const h = i * HIT_STRIDE; if (Math.abs(tracer.hits[h + 4] - tracer.hits[h + 6]) > .2) coloured++; }
    expect(coloured).toBeGreaterThan(0);
    const out = signalsFromStats(stats, emptySignals());
    expect(out.occluded).toBeGreaterThan(0); expect(out.occluded).toBeLessThan(1);
  });
  it('builds occluders from a scan row: each run becomes a band of straight pieces behind the shell', () => {
    const width = 32, height = 8, z = new Float32Array(width * height).fill(1), mask = new Uint8Array(width * height);
    const row = 4, set = (c: number, d: number) => { z[row * width + c] = d; mask[row * width + c] = 255; };
    for (let c = 8; c < 16; c++) set(c, .3);          // a flat palm
    for (let c = 16; c < 20; c++) set(c, .2);         // a finger in front of it, in the same run
    for (let c = 24; c < 26; c++) set(c, .6);         // another body
    const field: SurfaceField = { width, height, z, mask }, cell = ASPECT / width, occ = new OccluderSet();
    occ.begin(.55);
    expect(addScanOccluders(occ, field, .55, ASPECT, DEPTH, SCAN_THICKNESS, SCAN_TOLERANCE, null)).toBe(3);
    expect(occ.groupCount).toBe(2); expect(occ.kind[0]).toBe(OCCLUDER_QUAD);
    const want = [8 * cell, .3, 16 * cell, .3, 16 * cell, .3 + SCAN_THICKNESS, 8 * cell, .3 + SCAN_THICKNESS];
    quadCorners(occ, 0).forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
    expect(quadCorners(occ, 1)[0]).toBeCloseTo(16 * cell, 9); expect(quadCorners(occ, 1)[1]).toBeCloseTo(.2, 6);
    expect(quadCorners(occ, 2)[0]).toBeCloseTo(24 * cell, 9); expect(quadCorners(occ, 2)[1]).toBeCloseTo(.6, 6);
    // Rays from the glass stop at the shell where the row is scanned and reach the back wall where it is not; from behind, the band is `thickness` deep.
    const tracer = new Tracer(100);
    const options: TraceOptions = { ...noGlass, bounds: [0, 0, ASPECT, DEPTH] };
    const from = (col: number, front: boolean): BeamSource => ({ x: (col + .5) * cell, y: front ? .01 : DEPTH - .01, dirX: 0, dirY: front ? 1 : -1, width: 0, intensity: 1, rays: 1, gain: 1 });
    expect(tracer.trace([], [from(10, true)], options, occ).occludedRays).toBe(1); expect(tracer.segments[3]).toBeCloseTo(.3, 6);
    tracer.trace([], [from(17, true)], options, occ); expect(tracer.segments[3]).toBeCloseTo(.2, 6);
    expect(tracer.trace([], [from(21, true)], options, occ).occludedRays).toBe(0); expect(tracer.segments[3]).toBeCloseTo(DEPTH, 6);
    tracer.trace([], [from(10, false)], options, occ); expect(tracer.segments[3]).toBeCloseTo(.3 + SCAN_THICKNESS, 6);
    expect(tracer.hits[2]).toBeCloseTo(0, 6); expect(tracer.hits[3]).toBeCloseTo(1, 6);   // the back edge's normal points to the back wall
    // The plane's height picks the row: a plane through an empty row has nothing in it.
    occ.begin(.1); expect(addScanOccluders(occ, field, .1, ASPECT, DEPTH, SCAN_THICKNESS, SCAN_TOLERANCE, null)).toBe(0); expect(occ.groupCount).toBe(0);
    // A straight ramp stays one piece; a bend splits it.
    for (let c = 8; c < 20; c++) set(c, .2 + .01 * (c - 8));
    occ.begin(.55); expect(addScanOccluders(occ, field, .55, ASPECT, DEPTH, SCAN_THICKNESS, SCAN_TOLERANCE, null)).toBe(2);
    for (let c = 14; c < 20; c++) set(c, .2 + .01 * (c - 8) + SCAN_TOLERANCE * 3);
    occ.begin(.55); expect(addScanOccluders(occ, field, .55, ASPECT, DEPTH, SCAN_THICKNESS, SCAN_TOLERANCE, null)).toBe(3);
    // The run holding the beam's origin is the emitter: its pieces are passed through and the palm reach grows from those the origin touches.
    const emitter: Emitter = { x: 11 * cell, y: .55, z: .32, reach: PALM_REACH, touch: .02 };
    occ.begin(.55, emitter.x, emitter.z); addScanOccluders(occ, field, .55, ASPECT, DEPTH, SCAN_THICKNESS, SCAN_TOLERANCE, emitter);
    expect(occ.emitter[0]).toBe(1); expect(occ.emitter[occ.count - 1]).toBe(0); expect(occ.palmReach).toBeGreaterThan(0);
    const inside: BeamSource = { x: emitter.x, y: emitter.z, dirX: 1, dirY: 0, width: 0, intensity: 1, rays: 1, gain: 1, clearance: { x: emitter.x, y: emitter.z, radius: Math.min(CLEARANCE_MAX, occ.palmReach) } };
    const st = tracer.trace([], [inside], options, occ);
    expect(st.occludedRays).toBe(0); expect(tracer.segments[2]).toBeCloseTo(ASPECT, 6);
  });
  it('the synthetic performer\'s scan at palm height: the palm run lets its own beam out, and a second hand\'s scan shadows it', () => {
    // Built exactly as the source and tracker do it: a scan of the skeleton, resampled through the image mapping.
    const near = { x: .35, y: .5, z: .3 }, far = { x: .65, y: .5, z: .3 };
    const nearCapsules = syntheticHandCapsules(near, 1, .05), farCapsules = syntheticHandCapsules(far, 1, .05, true);
    const field = mapSurface(IMAGE_MAPPING, surfaceFromCapsules([...nearCapsules, ...farCapsules], 64, 48), 96, 64)!;
    const palm = mapPoint(IMAGE_MAPPING, near), other = mapPoint(IMAGE_MAPPING, far);
    const px = palm.x * ASPECT, pz = palm.z * DEPTH, width = beamWidth(TRACE_DEFAULTS.beam, 1);
    const emitter: Emitter = { x: px, y: palm.y, z: pz, reach: PALM_REACH, touch: width / 2 + TOUCH_MARGIN };
    const occ = new OccluderSet();
    occ.begin(palm.y, px, pz);
    const quads = addScanOccluders(occ, field, palm.y, ASPECT, DEPTH, SCAN_THICKNESS, SCAN_TOLERANCE, emitter);
    expect(quads).toBeGreaterThanOrEqual(2); expect(occ.groupCount).toBeGreaterThanOrEqual(2); expect(occ.palmReach).toBeGreaterThan(0);
    const options = traceOptionsFor(QUALITY.medium, buildSpectrum(64), TRACE_DEFAULTS, ASPECT, DEPTH, CAUCHY_B_GLASS);
    const tracer = new Tracer(MAX_SEGMENTS);
    // Toward the other hand (along x): the beam leaves its own palm and is stopped by the other hand's scan.
    const dir = Math.sign(other.x - palm.x);
    const beam: BeamSource = { x: px, y: pz, dirX: dir, dirY: 0, width, intensity: 1, rays: 24, gain: 1, clearance: { x: px, y: pz, radius: Math.min(CLEARANCE_MAX, occ.palmReach) } };
    const stats = tracer.trace([], [beam], options, occ);
    // Most of the beam is stopped; its edge rays can slip past the gap at the other hand's thumb.
    expect(stats.occluded / stats.launched).toBeGreaterThan(.7);
    const otherX = other.x * ASPECT;
    for (let i = 0; i < tracer.hitCount; i++) expect(Math.abs(tracer.hits[i * HIT_STRIDE] - otherX)).toBeLessThan(.2);
    // Away from it (into the volume): nothing in the way.
    const away = { ...beam, dirX: 0, dirY: 1 };
    const clear = tracer.trace([], [away], options, occ);
    expect(clear.occluded).toBe(0);
  });
});

describe('declaration', () => {
  it('declares the volume-era params and signals with ranges the host can trust', () => {
    expect(Object.keys(prism.params).length).toBeLessThanOrEqual(12);
    expect(prism.params.height.kind).toBe('number'); expect(prism.params.size.default).toBe(TRACE_DEFAULTS.size);
    for (const name of ['spread', 'hue', 'brightness', 'reflected', 'incidence', 'inside', 'elevation', 'occluded']) { expect(prism.signals[name as keyof typeof prism.signals].min).toBe(0); expect(prism.signals[name as keyof typeof prism.signals].max).toBe(1); }
    expect(prism.signals.elevation.description).toMatch(/height/i);
    expect(prism.signals.occluded.description).toMatch(/stopped/i);
  });
});

describe('spectrum colour', () => {
  it('wavelength → rgb is finite and non-negative across and beyond the visible range', () => {
    for (let nm = 300; nm <= 900; nm++) for (const c of wavelengthToRgb(nm)) { expect(Number.isFinite(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0); }
    const red = wavelengthToRgb(650), green = wavelengthToRgb(535), blue = wavelengthToRgb(450);
    expect(red[0]).toBeGreaterThan(red[1]); expect(red[0]).toBeGreaterThan(red[2]);
    expect(green[1]).toBeGreaterThan(green[0]); expect(green[1]).toBeGreaterThan(green[2]);
    expect(blue[2]).toBeGreaterThan(blue[0]); expect(blue[2]).toBeGreaterThan(blue[1]);
  });
  it('a sampled spectrum sums back to white', () => {
    for (const count of [12, 16, 24]) {
      const s = buildSpectrum(count);
      const sum = [0, 0, 0];
      for (let k = 0; k < s.count; k++) for (let c = 0; c < 3; c++) sum[c] += s.rgb[k * 3 + c] / s.count;
      for (const c of sum) expect(c).toBeCloseTo(1, 5);
      for (let k = 0; k < s.count; k++) { expect(s.hue[k]).toBeGreaterThanOrEqual(0); expect(s.hue[k]).toBeLessThanOrEqual(1); }
      expect(s.hue[s.count - 1]).toBeLessThan(.1);  // red end
      expect(s.hue[0]).toBeGreaterThan(.6);           // violet end
    }
  });
});
