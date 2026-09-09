/**
 * Prism optics: a deterministic 2D ray tracer for white light through convex
 * glass polygons. Pure TypeScript, no WebGL, no allocation in the hot loop, so
 * it can be unit-tested and profiled on its own.
 *
 * Physics: Snell refraction, unpolarised Fresnel reflectance, total internal
 * reflection, Cauchy dispersion n(λ) = A + B/λ² (λ in µm). Colour: a Gaussian
 * fit of the CIE 1931 colour matching functions converted to linear sRGB and
 * normalised so that the whole spectrum sums back to white.
 *
 * Units: whatever the caller uses; the simulation works in "uniform" units
 * (canvas height = 1, width = aspect).
 */

/** Cauchy B of a typical crown glass, in µm². `dispersion = 1` in the simulation means this. */
export const CAUCHY_B_GLASS = .004;

/** Cauchy refractive index for a wavelength in micrometres. */
export function cauchyIndex(lambdaUm: number, a: number, b: number): number { return a + b / (lambdaUm * lambdaUm); }

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function piecewiseGaussian(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-.5 * t * t);
}

/** CIE 1931 XYZ colour matching functions (Wyman, Sloan & Shirley 2013 multi-lobe fit), wavelength in nm. */
export function wavelengthToXyz(nm: number): [number, number, number] {
  const x = 1.056 * piecewiseGaussian(nm, 599.8, 37.9, 31.0) + .362 * piecewiseGaussian(nm, 442.0, 16.0, 26.7) - .065 * piecewiseGaussian(nm, 501.1, 20.4, 26.2);
  const y = .821 * piecewiseGaussian(nm, 568.8, 46.9, 40.5) + .286 * piecewiseGaussian(nm, 530.9, 16.3, 31.1);
  const z = 1.217 * piecewiseGaussian(nm, 437.0, 11.8, 36.0) + .681 * piecewiseGaussian(nm, 459.0, 26.0, 13.8);
  return [x, y, z];
}

/** Linear sRGB for a monochromatic wavelength (nm); out-of-gamut components are clipped to zero. Always finite and non-negative. */
export function wavelengthToRgb(nm: number): [number, number, number] {
  const [x, y, z] = wavelengthToXyz(nm);
  const r = 3.2406 * x - 1.5372 * y - .4986 * z;
  const g = -.9689 * x + 1.8758 * y + .0415 * z;
  const b = .0557 * x - .2040 * y + 1.0570 * z;
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

/** Hue in 0..1 of an rgb triple (0 when grey). */
export function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d <= 1e-9) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}

export interface Spectrum {
  readonly count: number;
  /** Wavelength of each sample in µm. */
  readonly lambdaUm: Float32Array;
  /** rgb per sample (3 floats each), scaled so that the mean over all samples is exactly (1, 1, 1). */
  readonly rgb: Float32Array;
  /** Hue of each sample in 0..1. */
  readonly hue: Float32Array;
}

/**
 * Sample `count` wavelengths across the visible range (bin centres) and
 * normalise their colours so that white light split into these samples with
 * energy 1/count each adds back to (1, 1, 1).
 */
export function buildSpectrum(count: number, minNm = 400, maxNm = 700): Spectrum {
  const n = Math.max(1, Math.floor(count));
  const lambdaUm = new Float32Array(n), rgb = new Float32Array(n * 3), hue = new Float32Array(n);
  const sum = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const nm = minNm + ((k + .5) / n) * (maxNm - minNm);
    lambdaUm[k] = nm / 1000;
    const c = wavelengthToRgb(nm);
    rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
    sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
  }
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++) rgb[k * 3 + c] = sum[c] > 0 ? (rgb[k * 3 + c] * n) / sum[c] : 1;
    hue[k] = rgbToHue(rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]);
  }
  return { count: n, lambdaUm, rgb, hue };
}

// ---------------------------------------------------------------------------
// Surface interactions. Directions and normals are unit vectors; the normal
// points towards the side the ray arrives from, so dot(d, n) < 0.
// ---------------------------------------------------------------------------

/**
 * Snell refraction. `eta = n1 / n2`. Writes the refracted unit direction into
 * `out[0..1]` and returns cos of the transmitted angle, or -1 on total
 * internal reflection (then `out` is untouched).
 */
export function refract(dx: number, dy: number, nx: number, ny: number, eta: number, out: Float64Array): number {
  const cosI = Math.min(1, Math.max(0, -(dx * nx + dy * ny)));
  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return -1;
  const cosT = Math.sqrt(k);
  const m = eta * cosI - cosT;
  out[0] = eta * dx + m * nx; out[1] = eta * dy + m * ny;
  // Re-normalise against drift over many interactions (Math.sqrt: Math.hypot is an order of magnitude slower in V8).
  const inv = 1 / (Math.sqrt(out[0] * out[0] + out[1] * out[1]) || 1);
  out[0] *= inv; out[1] *= inv;
  return cosT;
}

/** Mirror reflection of a direction about a normal. */
export function reflect(dx: number, dy: number, nx: number, ny: number, out: Float64Array): void {
  const d = 2 * (dx * nx + dy * ny);
  out[0] = dx - d * nx; out[1] = dy - d * ny;
}

/** Unpolarised Fresnel reflectance (mean of s and p) for a refracting interface. */
export function fresnelReflectance(cosI: number, cosT: number, n1: number, n2: number): number {
  const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
  return Math.min(1, Math.max(0, .5 * (rs * rs + rp * rp)));
}

/** Angle (radians) beyond which light going from n1 into n2 < n1 is totally reflected; π/2 when there is none. */
export function criticalAngle(n1: number, n2: number): number { return n2 >= n1 ? Math.PI / 2 : Math.asin(n2 / n1); }

// ---------------------------------------------------------------------------
// Convex polygons
// ---------------------------------------------------------------------------

export interface Polygon {
  count: number;
  /** Vertices, counter-clockwise. Edge i runs from vertex i to vertex i+1. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Outward unit normal of edge i. */
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  cx: number; cy: number;
  /** Circumradius: every vertex lies within this distance of the centre. */
  radius: number;
}

export function createPolygon(maxVertices = 8): Polygon {
  return { count: 0, x: new Float64Array(maxVertices), y: new Float64Array(maxVertices), nx: new Float64Array(maxVertices), ny: new Float64Array(maxVertices), cx: 0, cy: 0, radius: 0 };
}

/** Fill `poly` with a regular polygon; `rotation` in radians, vertex 0 at that angle. */
export function setRegularPolygon(poly: Polygon, sides: number, cx: number, cy: number, radius: number, rotation: number): Polygon {
  const n = Math.max(3, Math.min(poly.x.length, Math.floor(sides)));
  poly.count = n; poly.cx = cx; poly.cy = cy; poly.radius = radius;
  for (let i = 0; i < n; i++) { const a = rotation + (i / n) * Math.PI * 2; poly.x[i] = cx + radius * Math.cos(a); poly.y[i] = cy + radius * Math.sin(a); }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = poly.x[j] - poly.x[i], ey = poly.y[j] - poly.y[i], len = Math.hypot(ex, ey) || 1;
    poly.nx[i] = ey / len; poly.ny[i] = -ex / len;
  }
  return poly;
}

/** True when the point lies strictly inside the convex polygon. */
export function pointInPolygon(poly: Polygon, px: number, py: number): boolean {
  for (let i = 0; i < poly.count; i++) if ((px - poly.x[i]) * poly.nx[i] + (py - poly.y[i]) * poly.ny[i] >= 0) return false;
  return true;
}

const HIT_EPSILON = 1e-7;

/**
 * Nearest crossing of the ray with an edge of the polygon, ignoring `skipEdge`.
 * Returns the ray parameter t (> 0) and writes the edge index into `outEdge[0]`, or returns Infinity for a miss.
 */
export function intersectPolygon(poly: Polygon, ox: number, oy: number, dx: number, dy: number, skipEdge: number, outEdge: Int32Array): number {
  let best = Infinity, bestEdge = -1;
  const n = poly.count;
  for (let i = 0; i < n; i++) {
    if (i === skipEdge) continue;
    const nx = poly.nx[i], ny = poly.ny[i];
    const denom = dx * nx + dy * ny;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const ax = poly.x[i], ay = poly.y[i];
    const t = ((ax - ox) * nx + (ay - oy) * ny) / denom;
    if (t <= HIT_EPSILON || t >= best) continue;
    const j = (i + 1) % n;
    const ex = poly.x[j] - ax, ey = poly.y[j] - ay;
    const hx = ox + t * dx - ax, hy = oy + t * dy - ay;
    const s = (hx * ex + hy * ey) / (ex * ex + ey * ey);
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    best = t; bestEdge = i;
  }
  outEdge[0] = bestEdge;
  return best;
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

/** A parallel beam of white light. `gain` converts physical energy into stored segment intensity. */
export interface BeamSource {
  x: number; y: number;
  /** Unit direction. */
  dirX: number; dirY: number;
  /** Full beam width, in scene units. */
  width: number;
  /** Energy per ray at the beam centre (0..1). */
  intensity: number;
  rays: number;
  gain: number;
}

export interface TraceOptions {
  /** Fine wavelength table. */
  spectrum: Spectrum;
  /**
   * Wavelengths traced per ray (defaults to the whole table). With a finer table than this, consecutive rays
   * across the beam use interleaved samples (ray i takes entries j·M + i mod M, M = table / samples), so a
   * fan of 16 samples per ray still shows 64 distinct wavelengths without striping.
   */
  samplesPerRay?: number;
  /** Cauchy A and B (B in µm²). */
  glassA: number;
  glassB: number;
  /** Maximum surface interactions per light path that may spawn a reflection. Transmission is always followed, so a path never dies on a surface except under total internal reflection past the cap. */
  bounces: number;
  /** Rays below this energy are not followed. */
  minEnergy: number;
  /** Scene rectangle rays are clipped to: x0, y0, x1, y1. */
  bounds: readonly [number, number, number, number];
}

export interface TraceStats {
  segments: number;
  insideSegments: number;
  /** True when the segment cap stopped the trace early. Rays are launched interleaved across the beam, so what was traced is an evenly thinned beam. */
  truncated: boolean;
  /** Number of rays launched across all sources. */
  rays: number;
  /** Energy launched and energy that reached the scene bounds. */
  launched: number;
  exitEnergy: number;
  /** Exiting energy that was reflected at least once. */
  exitReflected: number;
  /** Energy-weighted resultant of exit directions. */
  exitDirX: number;
  exitDirY: number;
  /** Sum of energy × sample hue over exiting light (a wavelength centroid once divided by exitEnergy). */
  exitHue: number;
  /** Sum of (incidence angle × energy) at first contact, and the energy that made contact. */
  incidenceSum: number;
  incidenceWeight: number;
}

/** Energy weight of a ray at offset s ∈ [-½, ½] across the beam: soft edges, 1 at the centre. */
export const beamProfile = (s: number) => .3 + .7 * (1 - 4 * s * s);
/** Mean of `beamProfile` across the beam, so a whole beam that leaves the scene reads as brightness 1. */
export const BEAM_PROFILE_MEAN = .3 + .7 * (2 / 3);

/** Floats per segment in `Tracer.segments`: x0, y0, x1, y1, r, g, b, intensity. */
export const SEGMENT_STRIDE = 8;
const MAX_STACK = 4096;
const SPECTRUM_SLOTS = 64;
const MAX_SPECTRUM = 64;
const MAX_EXITS = 16384;

export class Tracer {
  readonly segments: Float32Array;
  readonly stats: TraceStats = { segments: 0, insideSegments: 0, truncated: false, rays: 0, launched: 0, exitEnergy: 0, exitReflected: 0, exitDirX: 0, exitDirY: 0, exitHue: 0, incidenceSum: 0, incidenceWeight: 0 };
  /** Exit records for inspection (direction, energy, wavelength index or -1, reflected flag). Capped; `stats` are exact. */
  readonly exitDirX = new Float32Array(MAX_EXITS);
  readonly exitDirY = new Float32Array(MAX_EXITS);
  readonly exitEnergy = new Float32Array(MAX_EXITS);
  readonly exitKind = new Int16Array(MAX_EXITS);
  readonly exitReflected = new Uint8Array(MAX_EXITS);
  /** Mean hue of each exit record (a single sample's hue for dispersed light). */
  readonly exitHue = new Float32Array(MAX_EXITS);
  exitCount = 0;

  // Ray stack (depth first). `kind` is a wavelength index or -1 for a polychromatic ray whose spectrum lives in `spectra[slot]`.
  private readonly sx = new Float64Array(MAX_STACK); private readonly sy = new Float64Array(MAX_STACK);
  private readonly sdx = new Float64Array(MAX_STACK); private readonly sdy = new Float64Array(MAX_STACK);
  private readonly se = new Float64Array(MAX_STACK);
  private readonly skind = new Int16Array(MAX_STACK);
  /** Polygon the ray travels inside, or -1. */
  private readonly sinside = new Int8Array(MAX_STACK);
  /** Polygon and edge the ray just left (to avoid re-hitting the surface it starts on), or -1. */
  private readonly sfrom = new Int8Array(MAX_STACK);
  private readonly sedge = new Int8Array(MAX_STACK);
  private readonly sdepth = new Uint8Array(MAX_STACK);
  private readonly sreflected = new Uint8Array(MAX_STACK);
  private readonly sslot = new Uint8Array(MAX_STACK);
  /** Which interleaved subset of the wavelength table a polychromatic ray carries. */
  private readonly sphase = new Uint8Array(MAX_STACK);
  private readonly spectra = new Float64Array(SPECTRUM_SLOTS * MAX_SPECTRUM);
  private readonly slotFree = new Uint8Array(SPECTRUM_SLOTS);
  private readonly index = new Float64Array(MAX_SPECTRUM);
  private readonly reflectance = new Float64Array(MAX_SPECTRUM);
  private readonly outT = new Float64Array(2);
  private readonly outR = new Float64Array(2);
  private readonly colour = new Float64Array(3);
  private top = 0;

  constructor(readonly maxSegments = 20000) { this.segments = new Float32Array(maxSegments * SEGMENT_STRIDE); }

  get count() { return this.stats.segments; }

  trace(polygons: readonly Polygon[], sources: readonly BeamSource[], options: TraceOptions): TraceStats {
    const st = this.stats;
    st.segments = 0; st.insideSegments = 0; st.truncated = false; st.rays = 0; st.launched = 0; st.exitEnergy = 0; st.exitReflected = 0;
    st.exitDirX = 0; st.exitDirY = 0; st.exitHue = 0; st.incidenceSum = 0; st.incidenceWeight = 0;
    this.exitCount = 0; this.top = 0;
    this.slotFree.fill(1);
    const spectrum = options.spectrum;
    const S = Math.min(MAX_SPECTRUM, spectrum.count);
    const K = Math.max(1, Math.min(S, Math.floor(options.samplesPerRay ?? S)));
    const M = Math.max(1, Math.floor(S / K));
    for (let k = 0; k < S; k++) this.index[k] = cauchyIndex(spectrum.lambdaUm[k], options.glassA, options.glassB);

    for (const source of sources) {
      const rays = Math.max(1, Math.floor(source.rays));
      const px = -source.dirY, py = source.dirX; // across the beam
      // Rays are launched in bit-reversed order of their index across the beam (0, 4, 2, 6, 1, 5, 3, 7 for eight):
      // every prefix of that sequence is spread evenly over the width, so a frame that hits the segment cap thins
      // the whole beam instead of losing the rays on one side. The set of segments is unchanged when nothing is cut.
      let bits = 0;
      while ((1 << bits) < rays) bits++;
      for (let n = 0, total = 1 << bits; n < total; n++) {
        let i = 0;
        for (let b = 0, m = n; b < bits; b++, m >>= 1) i = (i << 1) | (m & 1);
        if (i >= rays) continue;
        if (st.truncated) return st;
        const s = (i + .5) / rays - .5;
        const energy = source.intensity * beamProfile(s);
        st.rays++; st.launched += energy;
        if (energy <= options.minEnergy) continue;
        const slot = this.allocateSlot();
        if (slot < 0) continue;
        const base = slot * MAX_SPECTRUM;
        for (let j = 0; j < K; j++) this.spectra[base + j] = energy / K;
        this.push(source.x + px * s * source.width, source.y + py * s * source.width, source.dirX, source.dirY, energy, -1, -1, -1, -1, 0, 0, slot, i % M);
        this.run(polygons, options, K, M, source.gain);
      }
    }
    return st;
  }

  private allocateSlot(): number {
    for (let i = 0; i < SPECTRUM_SLOTS; i++) if (this.slotFree[i]) { this.slotFree[i] = 0; return i; }
    return -1;
  }

  private push(x: number, y: number, dx: number, dy: number, e: number, kind: number, inside: number, from: number, edge: number, depth: number, reflected: number, slot: number, phase = 0): boolean {
    if (this.top >= MAX_STACK) { if (slot >= 0) this.slotFree[slot] = 1; return false; }
    const i = this.top++;
    this.sx[i] = x; this.sy[i] = y; this.sdx[i] = dx; this.sdy[i] = dy; this.se[i] = e;
    this.skind[i] = kind; this.sinside[i] = inside; this.sfrom[i] = from; this.sedge[i] = edge; this.sdepth[i] = depth; this.sreflected[i] = reflected; this.sslot[i] = slot < 0 ? 0 : slot; this.sphase[i] = phase;
    return true;
  }

  /**
   * The declared signals for the last trace. `hue` is taken over the light leaving in the dominant exit direction
   * (weights fall off as cos⁸ of the angle from the energy-weighted mean direction): a plain mean over everything
   * is constant for white light because energy is conserved, whereas the main fan loses its blue end to total
   * internal reflection at some incidences and its red end at others.
   */
  signals(out: RawSignals): RawSignals {
    const st = this.stats;
    signalsFromStats(st, out);
    const e = st.exitEnergy;
    if (e <= 1e-9) return out;
    const len = Math.sqrt(st.exitDirX * st.exitDirX + st.exitDirY * st.exitDirY);
    if (len < 1e-9) return out;
    const ux = st.exitDirX / len, uy = st.exitDirY / len;
    let sumW = 0, sumH = 0;
    const dx = this.exitDirX, dy = this.exitDirY, en = this.exitEnergy, hue = this.exitHue;
    for (let r = 0; r < this.exitCount; r++) {
      const c = dx[r] * ux + dy[r] * uy;
      if (c <= 0) continue;
      const c2 = c * c, c4 = c2 * c2, w = en[r] * c4 * c4;
      sumW += w; sumH += w * hue[r];
    }
    if (sumW > 1e-9) out.hue = Math.min(1, Math.max(0, sumH / sumW));
    return out;
  }

  /** Split a polychromatic ray meeting glass from outside into one refracted ray per wavelength plus a polychromatic reflection. */
  private splitWhite(hx: number, hy: number, dx: number, dy: number, nx: number, ny: number, cosI: number, e: number, slot: number, phase: number, hitPoly: number, hitEdge: number, depth: number, reflected: number, K: number, M: number, bounces: number, minEnergy: number) {
    const st = this.stats, spectra = this.spectra, index = this.index, reflectance = this.reflectance, outT = this.outT, outR = this.outR;
    const specBase = slot * MAX_SPECTRUM, nextDepth = Math.min(255, depth + 1), allowReflection = depth < bounces;
    st.incidenceSum += Math.acos(cosI) * e; st.incidenceWeight += e;
    let reflectedTotal = 0;
    for (let j = 0; j < K; j++) {
      const k = j * M + phase;
      const cosT = refract(dx, dy, nx, ny, 1 / index[k], outT);
      const R = cosT < 0 ? 1 : fresnelReflectance(cosI, cosT, 1, index[k]);
      reflectance[j] = R; reflectedTotal += spectra[specBase + j] * R;
    }
    // The reflection is pushed first so the dispersed fan is traced (and survives a segment cap) before it.
    if (allowReflection && reflectedTotal > minEnergy) {
      const rslot = this.allocateSlot();
      if (rslot >= 0) {
        const rBase = rslot * MAX_SPECTRUM;
        for (let j = 0; j < K; j++) spectra[rBase + j] = spectra[specBase + j] * reflectance[j];
        reflect(dx, dy, nx, ny, outR);
        this.push(hx, hy, outR[0], outR[1], reflectedTotal, -1, -1, hitPoly, hitEdge, nextDepth, 1, rslot, phase);
      }
    }
    for (let j = 0; j < K; j++) {
      const et = spectra[specBase + j] * (1 - reflectance[j]);
      if (et <= minEnergy || reflectance[j] >= 1) continue;
      const k = j * M + phase;
      refract(dx, dy, nx, ny, 1 / index[k], outT);
      this.push(hx, hy, outT[0], outT[1], et, k, hitPoly, hitPoly, hitEdge, nextDepth, reflected, -1);
    }
    this.slotFree[slot] = 1;
  }

  /** Colour of a polychromatic ray (energy-weighted mean of its sample colours), written into `this.colour`. */
  private polychromaticColour(specBase: number, K: number, M: number, phase: number, rgb: Float32Array, total: number) {
    let r = 0, g = 0, b = 0;
    const spectra = this.spectra;
    for (let j = 0; j < K; j++) { const ek = spectra[specBase + j], k = j * M + phase; r += ek * rgb[k * 3]; g += ek * rgb[k * 3 + 1]; b += ek * rgb[k * 3 + 2]; }
    const inv = total > 0 ? 1 / total : 0;
    const c = this.colour; c[0] = r * inv; c[1] = g * inv; c[2] = b * inv;
  }

  /**
   * Depth-first walk of the ray stack. The monochromatic path (the vast
   * majority of rays) is written inline with local typed-array aliases: V8
   * boxes doubles that cross non-inlined calls, and that allocation was the
   * dominant cost of a function-per-step version.
   */
  private run(polygons: readonly Polygon[], options: TraceOptions, K: number, M: number, gain: number) {
    const st = this.stats, spectrum = options.spectrum, rgb = spectrum.rgb, hue = spectrum.hue, spectra = this.spectra, index = this.index, colour = this.colour;
    const sx = this.sx, sy = this.sy, sdx = this.sdx, sdy = this.sdy, se = this.se, skind = this.skind, sinside = this.sinside, sfrom = this.sfrom, sedge = this.sedge, sdepth = this.sdepth, sreflected = this.sreflected, sslot = this.sslot, sphase = this.sphase;
    const seg = this.segments, maxSegments = this.maxSegments;
    const exitDirX = this.exitDirX, exitDirY = this.exitDirY, exitEnergyArr = this.exitEnergy, exitKind = this.exitKind, exitReflectedArr = this.exitReflected, exitHueArr = this.exitHue;
    const b0 = options.bounds[0], b1 = options.bounds[1], b2 = options.bounds[2], b3 = options.bounds[3];
    const minEnergy = options.minEnergy, bounces = Math.max(0, Math.floor(options.bounces)), polyCount = polygons.length;
    let top = this.top;
    while (top > 0) {
      const i = --top;
      const ox = sx[i], oy = sy[i], dx = sdx[i], dy = sdy[i], e = se[i];
      const kind = skind[i], inside = sinside[i], from = sfrom[i], lastEdge = sedge[i], depth = sdepth[i], reflected = sreflected[i], slot = sslot[i], phase = sphase[i];

      // Nearest surface. Inside a polygon only that polygon can be hit (polygons do not overlap).
      let hitT = Infinity, hitPoly = -1, hitEdge = -1;
      const pStart = inside >= 0 ? inside : 0, pEnd = inside >= 0 ? inside + 1 : polyCount;
      for (let p = pStart; p < pEnd; p++) {
        const poly = polygons[p], n = poly.count, px = poly.x, py = poly.y, pnx = poly.nx, pny = poly.ny;
        const skip = p === from ? lastEdge : -1;
        for (let k = 0; k < n; k++) {
          if (k === skip) continue;
          const nx = pnx[k], ny = pny[k];
          const denom = dx * nx + dy * ny;
          if (denom > -1e-12 && denom < 1e-12) continue;
          const ax = px[k], ay = py[k];
          const t = ((ax - ox) * nx + (ay - oy) * ny) / denom;
          if (t <= HIT_EPSILON || t >= hitT) continue;
          const j = k + 1 === n ? 0 : k + 1;
          const ex = px[j] - ax, ey = py[j] - ay;
          const qx = ox + t * dx - ax, qy = oy + t * dy - ay;
          const s = (qx * ex + qy * ey) / (ex * ex + ey * ey);
          if (s < -1e-9 || s > 1 + 1e-9) continue;
          hitT = t; hitPoly = p; hitEdge = k;
        }
      }

      // End point: the surface, or the scene bounds.
      let x1: number, y1: number, draw = true;
      if (hitEdge < 0) {
        let t = Infinity;
        if (dx > 1e-12) t = (b2 - ox) / dx; else if (dx < -1e-12) t = (b0 - ox) / dx;
        if (dy > 1e-12) { const ty = (b3 - oy) / dy; if (ty < t) t = ty; } else if (dy < -1e-12) { const ty = (b1 - oy) / dy; if (ty < t) t = ty; }
        if (!(t > 0) || t === Infinity) { draw = false; t = 0; }
        x1 = ox + dx * t; y1 = oy + dy * t;
      } else { x1 = ox + dx * hitT; y1 = oy + dy * hitT; }

      if (draw) {
        if (st.segments >= maxSegments) { st.truncated = true; top = 0; break; }
        const o = st.segments * SEGMENT_STRIDE;
        seg[o] = ox; seg[o + 1] = oy; seg[o + 2] = x1; seg[o + 3] = y1;
        if (kind >= 0) { seg[o + 4] = rgb[kind * 3]; seg[o + 5] = rgb[kind * 3 + 1]; seg[o + 6] = rgb[kind * 3 + 2]; }
        else { this.polychromaticColour(slot * MAX_SPECTRUM, K, M, phase, rgb, e); seg[o + 4] = colour[0]; seg[o + 5] = colour[1]; seg[o + 6] = colour[2]; }
        seg[o + 7] = e * gain;
        st.segments++;
        if (inside >= 0) st.insideSegments++;
      }

      if (hitEdge < 0) {
        // Leaves the scene.
        st.exitEnergy += e; st.exitDirX += e * dx; st.exitDirY += e * dy;
        if (reflected) st.exitReflected += e;
        let h: number;
        if (kind >= 0) h = hue[kind];
        else { const base = slot * MAX_SPECTRUM; let sum = 0; for (let j = 0; j < K; j++) sum += spectra[base + j] * hue[j * M + phase]; h = e > 0 ? sum / e : 0; this.slotFree[slot] = 1; }
        st.exitHue += e * h;
        if (this.exitCount < MAX_EXITS) { const r = this.exitCount++; exitDirX[r] = dx; exitDirY[r] = dy; exitEnergyArr[r] = e; exitKind[r] = kind; exitReflectedArr[r] = reflected; exitHueArr[r] = h; }
        continue;
      }

      const poly = polygons[hitPoly];
      // Normal facing the incident side.
      let nx = poly.nx[hitEdge], ny = poly.ny[hitEdge];
      if (inside >= 0) { nx = -nx; ny = -ny; }
      let cosI = -(dx * nx + dy * ny);
      if (cosI < 0) cosI = 0; else if (cosI > 1) cosI = 1;
      const allowReflection = depth < bounces;
      const nextDepth = depth < 255 ? depth + 1 : 255;

      if (kind < 0) {
        this.top = top;
        this.splitWhite(x1, y1, dx, dy, nx, ny, cosI, e, slot, phase, hitPoly, hitEdge, depth, reflected, K, M, bounces, minEnergy);
        top = this.top;
        continue;
      }

      // Monochromatic ray: Snell, Fresnel, total internal reflection.
      const n = index[kind];
      const n1 = inside >= 0 ? n : 1, n2 = inside >= 0 ? 1 : n, eta = n1 / n2;
      const kk = 1 - eta * eta * (1 - cosI * cosI);
      const dn = 2 * (dx * nx + dy * ny), rx = dx - dn * nx, ry = dy - dn * ny;
      if (kk < 0) {
        if (allowReflection && top < MAX_STACK) {
          const j = top++;
          sx[j] = x1; sy[j] = y1; sdx[j] = rx; sdy[j] = ry; se[j] = e; skind[j] = kind; sinside[j] = inside; sfrom[j] = hitPoly; sedge[j] = hitEdge; sdepth[j] = nextDepth; sreflected[j] = 1; sslot[j] = 0;
        }
        continue;
      }
      const cosT = Math.sqrt(kk);
      const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT), rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
      let R = .5 * (rs * rs + rp * rp);
      if (R > 1) R = 1;
      const et = e * (1 - R), er = e * R;
      if (allowReflection && er > minEnergy && top < MAX_STACK) {
        const j = top++;
        sx[j] = x1; sy[j] = y1; sdx[j] = rx; sdy[j] = ry; se[j] = er; skind[j] = kind; sinside[j] = inside; sfrom[j] = hitPoly; sedge[j] = hitEdge; sdepth[j] = nextDepth; sreflected[j] = 1; sslot[j] = 0;
      }
      if (et > minEnergy && top < MAX_STACK) {
        const m = eta * cosI - cosT;
        let tx = eta * dx + m * nx, ty = eta * dy + m * ny;
        const inv = 1 / (Math.sqrt(tx * tx + ty * ty) || 1);
        tx *= inv; ty *= inv;
        const j = top++;
        sx[j] = x1; sy[j] = y1; sdx[j] = tx; sdy[j] = ty; se[j] = et; skind[j] = kind; sinside[j] = inside >= 0 ? -1 : hitPoly; sfrom[j] = hitPoly; sedge[j] = hitEdge; sdepth[j] = nextDepth; sreflected[j] = reflected; sslot[j] = 0;
      }
    }
    this.top = top;
  }
}
// ---------------------------------------------------------------------------
// Signal helpers (pure, so the numbers can be tested).
// ---------------------------------------------------------------------------

export interface RawSignals { spread: number; hue: number; brightness: number; reflected: number; incidence: number; inside: number }

/** Reduce trace statistics to the declared signals, each in 0..1. `hue` is left untouched when no light exits. */
export function signalsFromStats(st: TraceStats, out: RawSignals): RawSignals {
  const e = st.exitEnergy;
  if (e > 1e-9) {
    const resultant = Math.min(1, Math.hypot(st.exitDirX, st.exitDirY) / e);
    // sqrt(2(1 - R)) is the angular standard deviation in radians for a tight bundle and saturates for a wide one.
    out.spread = Math.min(1, Math.sqrt(Math.max(0, 2 * (1 - resultant))) / (Math.PI / 2));
    // Wavelength centroid expressed as hue: ~0.3 for a complete spectrum, towards 0 when the blue end is lost to
    // total internal reflection, towards 0.7 when the red end is.
    out.hue = Math.min(1, Math.max(0, st.exitHue / e));
    out.reflected = Math.min(1, Math.max(0, st.exitReflected / e));
  } else { out.spread = 0; out.reflected = 0; }
  out.brightness = st.rays > 0 ? Math.min(1, Math.max(0, e / (st.rays * BEAM_PROFILE_MEAN))) : 0;
  out.incidence = st.incidenceWeight > 1e-9 ? Math.min(1, Math.max(0, st.incidenceSum / st.incidenceWeight / (Math.PI / 2))) : 0;
  out.inside = st.segments > 0 ? st.insideSegments / st.segments : 0;
  return out;
}
