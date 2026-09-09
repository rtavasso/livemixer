import { describe, expect, it } from 'vitest';
import {
  beamGain, beamWidth, idleOrbit, lightPlane, MAX_SEGMENTS, nextRayBudget, prismCentre, prismRadius, QUALITY, rayCount, TRACE_DEFAULTS, traceOptionsFor, wallOf,
} from '../../src/sim/sims/prism/config';
import {
  buildSpectrum, CAUCHY_B_GLASS, cauchyIndex, createPolygon, criticalAngle, fresnelReflectance, intersectPolygon, pointInPolygon, refract, reflect,
  SEGMENT_STRIDE, setRegularPolygon, signalsFromStats, Tracer, wavelengthToRgb, type BeamSource, type RawSignals, type TraceOptions,
} from '../../src/sim/sims/prism/optics';
import { convexHull, EYE_HEIGHT, faceBrightness, prismCamera, prismCorners, prismSilhouette } from '../../src/sim/sims/prism/geometry';
import { DEFAULT_EYE, transformPoint, windowCamera } from '../../src/sim/core/camera';
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
    const out: RawSignals = { spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0 };
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
    const out: RawSignals = { spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0 };
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
    const out: RawSignals = { spread: 0, hue: .3, brightness: 0, reflected: 0, incidence: 0, inside: 0 };
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
    const out: RawSignals = { spread: 0, hue: 0, brightness: 0, reflected: 0, incidence: 0, inside: 0 };
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

describe('declaration', () => {
  it('declares the volume-era params and signals with ranges the host can trust', () => {
    expect(Object.keys(prism.params).length).toBeLessThanOrEqual(12);
    expect(prism.params.height.kind).toBe('number'); expect(prism.params.size.default).toBe(TRACE_DEFAULTS.size);
    for (const name of ['spread', 'hue', 'brightness', 'reflected', 'incidence', 'inside', 'elevation']) { expect(prism.signals[name as keyof typeof prism.signals].min).toBe(0); expect(prism.signals[name as keyof typeof prism.signals].max).toBe(1); }
    expect(prism.signals.elevation.description).toMatch(/height/i);
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
