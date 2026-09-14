/**
 * Basin — GLSL. Stable-fluids passes on a square grid (uv ∈ [0,1]², velocity
 * in uv/s), a 16×16 probe, and the composite. Signed quantities go through
 * `readV/packV` (vec2) and `readS/packS` (float) so an RGBA8 fallback still
 * runs: with PACKED defined they are offset-encoded around 128/255.
 *
 * The grid is the water plane seen from above: grid x is world x, grid y is
 * world z (the glass edge at the bottom of the screen). Hands reach the fluid
 * only through their footprints on the water: stadiums (the wet part of each
 * capsule, or the sphere fallback) with a grip that is 0 above the surface, or
 * the scanned surface's wet cells looked up column by column. The composite
 * draws each hand's shadow on the floor as the union of its capsules (or the
 * scan's silhouette), every endpoint leaning and softening with its own
 * height, and a meniscus ring wherever the solid breaks the surface.
 */
import { GLSL_HEADER } from '../../gl/program';
import { MATERIAL_GLSL } from '../../gl/material';
import { WAVE_STORAGE_GLSL } from './waves';
import { BASIN_VIEW_GLSL } from './view';
import { BASIN_CERAMIC_GLSL } from './ceramic';
import { surfaceGlsl } from '../../gl/surface';
import {
  CAUSTIC_LACUNARITY, CAUSTIC_PERIOD, LIGHT_SHIFT, MAX_FOOTPRINTS, MAX_SHADOW_CAPSULES, PACKED_VELOCITY_SCALE, PENUMBRA_BASE, PENUMBRA_PER_HEIGHT,
  PROBE_ENC, PROBE_SIZE, PROBE_SUB, SCAN_THICKNESS,
} from './model';

export const MAX_HANDS = 4;
export const MAX_DROPS = 4;
/** Rows of the scan sampled per grid point (advect) and per pixel inside the scan's bound (composite). */
export const SCAN_ROWS = 24, SCAN_SHADOW_ROWS = 32;

const prelude = (packed: boolean) => `${GLSL_HEADER}
${packed ? '#define PACKED 1' : ''}
in vec2 v_uv; out vec4 o;
uniform vec2 u_texel;
uniform float u_bowl;
float bowlDist(vec2 uv) { return length(uv - 0.5); }
float hardMask(vec2 uv) { return step(bowlDist(uv), u_bowl); }
float softMask(vec2 uv) { return 1.0 - smoothstep(u_bowl - 2.5 * u_texel.x, u_bowl, bowlDist(uv)); }
// Distance from p to the segment a–b, with the parameter t of the nearest point (a stadium is this minus its radius).
float segDist(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 ab = b - a, ap = p - a;
  float l2 = dot(ab, ab);
  t = l2 > 1e-12 ? clamp(dot(ap, ab) / l2, 0.0, 1.0) : 0.0;
  return length(ap - ab * t);
}
#ifdef PACKED
const float VS = ${PACKED_VELOCITY_SCALE.toFixed(1)}; const float SS = 8.0; const float ZERO = 128.0 / 255.0;
vec2 readV(sampler2D s, vec2 uv) { return (texture(s, uv).xy - ZERO) * VS; }
vec4 packV(vec2 v) { return vec4(clamp(v / VS + ZERO, 0.0, 1.0), 0.0, 1.0); }
float readS(sampler2D s, vec2 uv) { return (texture(s, uv).x - ZERO) * SS; }
vec4 packS(float x) { return vec4(clamp(x / SS + ZERO, 0.0, 1.0), 0.0, 0.0, 1.0); }
#else
vec2 readV(sampler2D s, vec2 uv) { return texture(s, uv).xy; }
vec4 packV(vec2 v) { return vec4(v, 0.0, 1.0); }
float readS(sampler2D s, vec2 uv) { return texture(s, uv).x; }
vec4 packS(float x) { return vec4(x, 0.0, 0.0, 1.0); }
#endif
`;

/**
 * Advect velocity (semi-Lagrangian), dissipate, then add the footprints' drag and presses, drop impulses and a slow drift.
 * A footprint is the wet part of a capsule as a stadium on the plane (a point for the sphere fallback); the water under
 * it relaxes toward the velocity interpolated between its endpoints, as hard as the footprint grips (0 above the water).
 * With a scan (`u_surfaceReady`), the wet footprint is looked up per grid point instead: any scanned cell in this column
 * at or below the water level whose solid (SCAN_THICKNESS behind the shell) covers this depth.
 * `u_driftPhase` holds the four drift phases in cycles, already reduced modulo 1 (see model.ts `driftPhases`).
 */
export const advectVelocity = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_velocity;
uniform float u_dt, u_decay, u_decayFloor, u_drift, u_couple;
uniform vec4 u_driftPhase;
uniform int u_footCount;
uniform vec4 u_footSeg[${MAX_FOOTPRINTS}];   // a.xy, b.xy (grid uv): the wet part of a capsule's axis on the water plane
uniform vec4 u_footVel[${MAX_FOOTPRINTS}];   // velocity at a and at b (uv/s, stir gain applied)
uniform vec4 u_footMeta[${MAX_FOOTPRINTS}];  // radius (uv), grip 0..1, radial press (uv/s²), 0
uniform int u_dropCount;
uniform vec4 u_drops[${MAX_DROPS}];     // x, y, radius, impulse (uv/s)
${surfaceGlsl()}
uniform vec4 u_scanMap;      // grid uv → sim: x = uv.x * .x + .y, z = uv.y * .z + .w
uniform vec4 u_scanRows;     // sim y of the lowest wet row, the wet row span, water level, 0
uniform vec4 u_scanVel;      // wet centroid velocity (uv/s, stir gain applied), 0, 0
uniform vec4 u_scanPress;    // press centre x, y (uv), radius (uv), press (uv/s²)
const float THICK = ${SCAN_THICKNESS.toFixed(3)};
void main() {
  vec2 uv = v_uv;
  vec2 v0 = readV(u_velocity, uv);
  vec2 v = readV(u_velocity, uv - v0 * u_dt);
#ifdef PACKED
  // 8-bit storage rounds away a decrement of less than half a quantum, so a plain multiplicative decay
  // leaves small velocities stuck forever. Decay by at least u_decayFloor (> half a quantum; the CPU
  // applies it on a stride with the compound factor) so every velocity still reaches exactly zero.
  v -= sign(v) * min(abs(v), max(abs(v) * (1.0 - u_decay), vec2(u_decayFloor)));
#else
  v *= u_decay;
#endif
  for (int i = 0; i < ${MAX_FOOTPRINTS}; i++) {
    if (i >= u_footCount) break;
    vec4 f = u_footSeg[i]; vec4 fv = u_footVel[i]; vec4 m = u_footMeta[i];
    float t; float dist = segDist(uv, f.xy, f.zw, t);
    float q = dist * dist / (m.x * m.x);
    float g = exp(-q * 2.0);
    // The water under the footprint relaxes toward its velocity (bounded, stable), as hard as it grips the water.
    v += (mix(fv.xy, fv.zw, t) - v) * g * u_couple * m.y;
    // Pressing down in the water pushes it outward in a ring around the footprint.
    vec2 d = uv - mix(f.xy, f.zw, t);
    float len = length(d) + 1e-5;
    v += (d / len) * m.z * exp(-q * 1.2) * min(sqrt(q), 1.0) * u_dt;
  }
  if (u_surfaceReady == 1 && u_scanRows.y > 0.0) {
    float simX = uv.x * u_scanMap.x + u_scanMap.y, simZ = uv.y * u_scanMap.z + u_scanMap.w;
    float foot = 0.0;
    for (int k = 0; k < ${SCAN_ROWS}; k++) {
      float y = u_scanRows.x + (float(k) + 0.5) / ${SCAN_ROWS}.0 * u_scanRows.y;
      vec2 xy = vec2(simX, y);
      vec2 l = texture(u_surface, xy - vec2(u_surfaceTexel.x, 0.0)).rg, c = texture(u_surface, xy).rg, r = texture(u_surface, xy + vec2(u_surfaceTexel.x, 0.0)).rg;
      float w = l.g + c.g + r.g, m = w * (1.0 / 3.0);
      if (m < 0.01) continue;
      float dz = simZ - (l.r * l.g + c.r * c.g + r.r * r.g) / max(w, 1e-4);
      float body = smoothstep(-0.03, 0.0, dz) * (1.0 - smoothstep(THICK, THICK + 0.03, dz));
      // Deeper cells grip harder, like a capsule plunging past its radius.
      float depth = clamp((u_scanRows.z - y) / 0.06, 0.0, 1.0);
      foot = max(foot, m * body * depth * (2.0 - depth));
    }
    v += (u_scanVel.xy - v) * foot * u_couple;
    vec2 d = uv - u_scanPress.xy;
    float q = dot(d, d) / (u_scanPress.z * u_scanPress.z);
    float len = length(d) + 1e-5;
    v += (d / len) * u_scanPress.w * exp(-q * 1.2) * min(sqrt(q), 1.0) * u_dt;
  }
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= u_dropCount) break;
    vec4 dr = u_drops[i];
    vec2 d = uv - dr.xy;
    float q = dot(d, d) / (dr.z * dr.z);
    float len = length(d) + 1e-5;
    v += (d / len) * dr.w * exp(-q * 0.8) * min(sqrt(q) * 1.5, 1.0);
  }
  // A slow large-scale drift keeps the ink alive when nobody is there.
  vec4 ph = u_driftPhase;
  vec2 drift = vec2(
    sin(6.2832 * (uv.y * 1.3 + ph.x)) * cos(6.2832 * (uv.x * 0.9 + ph.y)),
    cos(6.2832 * (uv.x * 1.1 + ph.z)) * sin(6.2832 * (uv.y * 0.8 + ph.w)));
  v += drift * u_drift * u_dt;
  o = packV(v * softMask(uv));
}`;

export const curl = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_velocity;
void main() {
  vec2 uv = v_uv, x = vec2(u_texel.x, 0.0), y = vec2(0.0, u_texel.y);
  float L = readV(u_velocity, uv - x).y, R = readV(u_velocity, uv + x).y;
  float B = readV(u_velocity, uv - y).x, T = readV(u_velocity, uv + y).x;
  o = packS(0.5 * ((R - L) - (T - B)) * hardMask(uv));
}`;

export const vorticity = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_velocity, u_curl;
uniform float u_vorticity, u_dt;
void main() {
  vec2 uv = v_uv, x = vec2(u_texel.x, 0.0), y = vec2(0.0, u_texel.y);
  float L = readS(u_curl, uv - x), R = readS(u_curl, uv + x), B = readS(u_curl, uv - y), T = readS(u_curl, uv + y), C = readS(u_curl, uv);
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= u_vorticity * C;
  force.y *= -1.0;
  vec2 v = readV(u_velocity, uv) + force * u_dt;
  o = packV(v * softMask(uv));
}`;

export const divergence = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_velocity;
void main() {
  vec2 uv = v_uv, x = vec2(u_texel.x, 0.0), y = vec2(0.0, u_texel.y);
  float L = readV(u_velocity, uv - x).x, R = readV(u_velocity, uv + x).x;
  float B = readV(u_velocity, uv - y).y, T = readV(u_velocity, uv + y).y;
  o = packS(0.5 * ((R - L) + (T - B)) * hardMask(uv));
}`;

/** Jacobi relaxation with Neumann boundaries at the bowl wall (outside neighbours take the centre value). */
export const jacobi = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_pressure, u_divergence;
void main() {
  vec2 uv = v_uv, x = vec2(u_texel.x, 0.0), y = vec2(0.0, u_texel.y);
  float C = readS(u_pressure, uv);
  float L = mix(C, readS(u_pressure, uv - x), hardMask(uv - x));
  float R = mix(C, readS(u_pressure, uv + x), hardMask(uv + x));
  float B = mix(C, readS(u_pressure, uv - y), hardMask(uv - y));
  float T = mix(C, readS(u_pressure, uv + y), hardMask(uv + y));
  float div = readS(u_divergence, uv);
  o = packS((L + R + B + T - div) * 0.25 * hardMask(uv));
}`;

export const gradientSubtract = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_pressure, u_velocity;
void main() {
  vec2 uv = v_uv, x = vec2(u_texel.x, 0.0), y = vec2(0.0, u_texel.y);
  float C = readS(u_pressure, uv);
  float L = mix(C, readS(u_pressure, uv - x), hardMask(uv - x));
  float R = mix(C, readS(u_pressure, uv + x), hardMask(uv + x));
  float B = mix(C, readS(u_pressure, uv - y), hardMask(uv - y));
  float T = mix(C, readS(u_pressure, uv + y), hardMask(uv + y));
  vec2 v = readV(u_velocity, uv) - 0.5 * vec2(R - L, T - B);
  o = packV(v * softMask(uv));
}`;

/** Forward prediction for bounded MacCormack dye transport. */
export const predictDye = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_dye, u_velocity;
uniform float u_dt;
void main() {
  vec2 v = readV(u_velocity, v_uv);
  o = vec4(texture(u_dye, v_uv - v * u_dt).rgb * hardMask(v_uv), 1.0);
}`;

/** Advect dye, optionally correct numerical diffusion, then fade/inject once.
 * The local donor bounds suppress new extrema and negative pigment.
 */
export const advectDye = (packed: boolean, corrected = false) => `${prelude(packed)}
${corrected ? '#define CORRECT_DYE 1' : ''}
uniform sampler2D u_dye, u_velocity, u_prediction;
uniform float u_dt, u_fade, u_fadeFloor;
uniform int u_dropCount;
uniform vec4 u_drops[${MAX_DROPS}];      // x, y, radius, amount
uniform vec3 u_dropColor[${MAX_DROPS}];
void main() {
  vec2 uv = v_uv;
  vec2 v = readV(u_velocity, uv);
  vec2 donor = uv - v * u_dt;
  vec3 dye = texture(u_dye, donor).rgb;
#ifdef CORRECT_DYE
  vec3 predicted = texture(u_prediction, uv).rgb;
  vec3 reversed = texture(u_prediction, uv + v * u_dt).rgb;
  vec3 estimate = predicted + 0.5 * (texture(u_dye, uv).rgb - reversed);
  vec2 corner = (floor(donor / u_texel - 0.5) + 0.5) * u_texel;
  vec3 a = texture(u_dye, corner).rgb, b = texture(u_dye, corner + vec2(u_texel.x, 0)).rgb;
  vec3 c = texture(u_dye, corner + vec2(0, u_texel.y)).rgb, d = texture(u_dye, corner + u_texel).rgb;
  dye = clamp(estimate, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
#endif
#ifdef PACKED
  // Same as the velocity: 8-bit dye never fades by a sub-quantum factor, so fade by at least u_fadeFloor.
  dye -= min(dye, max(dye * (1.0 - u_fade), vec3(u_fadeFloor)));
#else
  dye *= u_fade;
#endif
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= u_dropCount) break;
    vec4 dr = u_drops[i];
    vec2 d = uv - dr.xy;
    float q = dot(d, d) / (dr.z * dr.z);
    // A bead: a flat-topped disc with a crisp edge and a faint skirt, like a drop that just landed.
    float g = exp(-q * q * q * 1.7) * 0.88 + exp(-q * 2.0) * 0.12;
    dye += u_dropColor[i] * dr.w * g;
  }
  o = vec4(min(dye, vec3(4.0)) * hardMask(uv), 1.0);
}`;

/** One texel per probe cell: masked means of speed, |curl| (1/s), angular momentum (signed), ink coverage. */
export const probe = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_velocity, u_curl, u_dye;
const int SIZE = ${PROBE_SIZE}; const int SUB = ${PROBE_SUB};
const float ENC_SPEED = ${PROBE_ENC.speed.toFixed(3)}, ENC_CURL = ${PROBE_ENC.curl.toFixed(3)}, ENC_ANG = ${PROBE_ENC.angular.toFixed(3)};
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0); float n = 0.0;
  for (int sy = 0; sy < SUB; sy++) for (int sx = 0; sx < SUB; sx++) {
    vec2 uv = (vec2(cell) + (vec2(float(sx), float(sy)) + 0.5) / float(SUB)) / float(SIZE);
    float m = hardMask(uv);
    vec2 v = readV(u_velocity, uv);
    float c = abs(readS(u_curl, uv)) / u_texel.x;
    vec2 r = uv - 0.5;
    float ang = r.x * v.y - r.y * v.x;
    float ink = min(1.0, dot(texture(u_dye, uv).rgb, vec3(0.3333)) * 3.0);
    acc += m * vec4(length(v) / ENC_SPEED, c / ENC_CURL, 128.0 / 255.0 + (127.0 / 255.0) * (ang / ENC_ANG), ink);
    n += m;
  }
  o = n > 0.0 ? clamp(acc / n, 0.0, 1.0) : vec4(0.0, 0.0, 128.0 / 255.0, 0.0);
}`;

/**
 * Composite: clear water over glazed ceramic, absorbing ink, normals from the
 * independent wave field, refracted caustics and a Fresnel window reflection,
 * a meniscus at the wall, a rounded ceramic lip, and the hands. Each shadow is the
 * union of its capsules on the plane (a disc and a stub of forearm for the
 * sphere fallback): every endpoint slides away from the window and softens
 * by its own height, so a tilted finger's shadow leans, a high hand's is a
 * soft displaced blur, and a hand in the water sits crisp and dark under
 * itself. Wherever a capsule's underside is below the surface, a bright
 * meniscus ring follows the wet part of it. With a scan the shadow is the
 * silhouette's cells projected onto the plane the same way, and the ring
 * is the outline of the row at the water level. Runs once at canvas resolution.
 */
export const composite = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_dye, u_velocity, u_pressure, u_wave;
uniform vec2 u_pixel, u_dyeTexel, u_waveTexel;
uniform vec3 u_glaze;
${MATERIAL_GLSL}
${BASIN_CERAMIC_GLSL}
${WAVE_STORAGE_GLSL}
${BASIN_VIEW_GLSL}
uniform float u_aspect, u_domain, u_light, u_caustics, u_presence;
// Caustic scroll offsets in lattice units, each in [0, HASH_PERIOD): layer a in xy, layer b in zw;
// u_caustT for the first value-noise octave, u_caustT2 for the second (see model.ts causticOffsets).
uniform vec4 u_caustT, u_caustT2;
uniform int u_shadowCount;
uniform vec4 u_shadowHands[${MAX_HANDS}];          // bounding circle x, y, radius (grid uv), opacity 0..1 (fades after the hand leaves)
uniform vec4 u_shadowMeta[${MAX_HANDS}];           // first capsule, capsule count, 0, 0
uniform vec4 u_capSeg[${MAX_SHADOW_CAPSULES}];     // a.xy, b.xy (grid uv) on the water plane
uniform vec4 u_capMeta[${MAX_SHADOW_CAPSULES}];    // radius (uv), underside clearance at a and at b (uniform units; < 0 in the water), weight (negative: shadow only)
${surfaceGlsl()}
uniform vec4 u_scanMap;      // grid uv → sim: x = uv.x * .x + .y, z = uv.y * .z + .w
uniform vec4 u_scanRows;     // sim y of the lowest scanned row, the row span, water level, wet gate for the ring
uniform vec4 u_scan;         // bounding circle x, y, radius (uv), opacity
const vec2 LIGHT_SHIFT = vec2(${LIGHT_SHIFT[0].toFixed(3)}, ${LIGHT_SHIFT[1].toFixed(3)});
const float PEN_BASE = ${PENUMBRA_BASE.toFixed(3)}, PEN_H = ${PENUMBRA_PER_HEIGHT.toFixed(3)};
const float THICK = ${SCAN_THICKNESS.toFixed(3)};

// The lattice hash is periodic so the scroll offsets can wrap without a seam, and so fp32 never
// sees a large lattice coordinate (a raw, unbounded time coarsened the web after a few hours).
const float HASH_PERIOD = ${CAUSTIC_PERIOD.toFixed(1)};
float hash(vec2 p) { p = mod(p, HASH_PERIOD); p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Two octaves; the time offset of each is passed separately, already wrapped at HASH_PERIOD.
float causticLayer(vec2 p, vec2 o1, vec2 o2) {
  float n = vnoise(p + o1) * 0.62 + vnoise(p * ${CAUSTIC_LACUNARITY.toFixed(2)} + 7.1 + o2) * 0.38;
  return pow(1.0 - abs(n * 2.0 - 1.0), 9.0);
}
float lum(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }
// The scan across three columns ex apart: mask-weighted depth in x (so the blur never pulls in the back wall), mean mask in y.
vec3 scanSample(vec2 xy, float ex) {
  vec2 l = texture(u_surface, xy - vec2(ex, 0.0)).rg, c = texture(u_surface, xy).rg, r = texture(u_surface, xy + vec2(ex, 0.0)).rg;
  float w = l.g + c.g + r.g;
  return vec3((l.r * l.g + c.r * c.g + r.r * r.g) / max(w, 1e-4), w * (1.0 / 3.0), 0.0);
}
// The scan's wet coverage at a grid point, from the row at the water level: the waterline is its outline.
float scanWaterline(vec2 gp) {
  vec2 xy = vec2(gp.x * u_scanMap.x + u_scanMap.y, u_scanRows.z);
  vec3 sc = scanSample(xy, u_surfaceTexel.x);
  float dz = gp.y * u_scanMap.z + u_scanMap.w - sc.x;
  float e = max(PEN_BASE * u_domain, THICK * 0.2);
  return sc.y * smoothstep(-e, e, dz) * (1.0 - smoothstep(THICK - e, THICK + e, dz));
}

vec4 finishBasin(vec3 color) {
  vec2 q = v_uv - 0.5;
  return vec4(filmicOutput(color * (1.0 - 0.22 * dot(q, q)), gl_FragCoord.xy), 1.0);
}
// A clean water surface mirrors the window with pixel-width edges. The rough
// ceramic uses the broad studio environment; sharing its blur made water hazy.
vec3 waterEnvironment(vec3 r) {
  vec2 p = r.xy / max(r.z, 0.1);
  vec2 aa = max(fwidth(p) * 1.15, vec2(0.0008));
  vec2 q = abs(p - vec2(-0.28, 1.12));
  vec2 pane = 1.0 - smoothstep(vec2(0.22, 0.25) - aa, vec2(0.22, 0.25) + aa, q);
  vec2 bar = smoothstep(vec2(0.008) - aa, vec2(0.008) + aa, q);
  float window = pane.x * pane.y * mix(0.06, 1.0, bar.x * bar.y);
  return vec3(0.055, 0.07, 0.085) + vec3(6.2, 6.6, 7.0) * window * smoothstep(0.0, 0.1, r.z);
}
bool basinEdge;
vec4 shadeBasin(vec2 uv) {
  vec2 screen = (uv - 0.5) * vec2(u_aspect, 1.0) / u_domain;
  vec3 eye, ray; basinCamera(screen, eye, ray);
  vec3 V = -ray;
  float R = u_bowl, scale = R / 0.42;
  float px = u_pixel.y / u_domain;
  vec3 Ld = normalize(vec3(-0.48, 0.40, 0.78));
  vec2 L2 = normalize(Ld.xy);
  float rimHeight = 0.009 * scale, rimRadius = R + 0.012 * scale, rimTube = 0.013 * scale;

  // Intersect the table, the outside of a turned bowl, and its rolled lip.
  // These are actual surfaces with depth ordering, not rings shaded on a flat disc.
  float tableT = (-0.225 * scale - eye.z) / ray.z;
  vec3 tablePoint = eye + ray * tableT;
  vec2 grainUV = tablePoint.xy * 160.0;
  float grainKeep = 1.0 - smoothstep(0.35, 0.9, max(fwidth(grainUV).x, fwidth(grainUV).y));
  float stone = (materialNoise(grainUV) - 0.5) * grainKeep;
  vec2 shadowPoint = tablePoint.xy - vec2(0.04, -0.04) * scale;
  float shadow = 1.0 - 0.60 * exp(-dot(shadowPoint, shadowPoint) / (R * R * 0.62));
  shadow *= 1.0 - 0.28 * exp(-dot(tablePoint.xy, tablePoint.xy) / (R * R * 0.12));
  vec3 opaque = vec3(0.035, 0.032, 0.028) * (1.0 + stone * 0.14) * shadow;
  float opaqueT = tableT;
  vec3 outerCentre = vec3(0, 0, 0.025 * scale);
  float outerZ = 0.25 * scale;
  float outerXY = (R + 0.025 * scale) / sqrt(1.0 - pow((rimHeight - outerCentre.z) / outerZ, 2.0));
  vec3 outerRadii = vec3(outerXY, outerXY, outerZ);
  vec3 localEye = (eye - outerCentre) / outerRadii, localRay = ray / outerRadii;
  float closestT = max(0.0, -dot(localEye, localRay) / dot(localRay, localRay));
  float silhouette = length(localEye + localRay * closestT) - 1.0;
  basinEdge = abs(silhouette) < px * 5.0 / scale;
  vec2 roots = ellipsoidRoots(eye, ray, outerCentre, outerRadii);
  float bodyT = roots.x;
  if ((eye + ray * bodyT).z > rimHeight) bodyT = roots.y;
  vec3 bodyPoint = eye + ray * bodyT;
  if (bodyT > 0.0 && bodyT < opaqueT && bodyPoint.z <= rimHeight) {
    vec3 N = ellipsoidNormal(bodyPoint, outerCentre, outerRadii);
    float diffuse = 0.20 + 0.80 * max(dot(N, Ld), 0.0);
    vec3 ceramic = mix(vec3(0.48, 0.47, 0.42), u_glaze, 0.12);
    opaque = ceramic * diffuse + studioEnvironment(reflect(ray, N), 0.12) * 0.025 * u_light;
    opaqueT = bodyT;
  }
  float lipBounds = rimHit(eye, ray, rimRadius, rimTube + px, rimHeight, px * 0.25);
  basinEdge = basinEdge || lipBounds < 1e4;
  float lipT = lipBounds < 1e4 ? rimHit(eye, ray, rimRadius, rimTube, rimHeight, px * 0.12) : 1e5;
  if (lipT < opaqueT) {
    vec3 N = rimNormal(eye + ray * lipT, rimRadius, rimHeight);
    opaque = vec3(0.48, 0.47, 0.42) * (0.24 + 0.76 * max(dot(N, Ld), 0.0));
    opaque += studioEnvironment(reflect(ray, N), 0.08) * 0.03 * u_light;
    opaqueT = lipT;
  }

  // Project the same x/depth water field through the camera. Two height
  // corrections give ripple parallax without a dense displaced mesh.
  float waterT = -eye.z / ray.z;
  vec3 waterPoint = eye + ray * waterT;
  for (int i = 0; i < 2; i++) {
    float height = waveHeight(u_wave, waterPoint.xy + 0.5);
    waterT = (height - eye.z) / ray.z;
    waterPoint = eye + ray * waterT;
  }
  vec2 g = waterPoint.xy + 0.5;
  vec2 rel = g - 0.5;
  float d = length(rel);
  vec2 dir = rel / max(d, 1e-5);
  if (d >= R || opaqueT < waterT) return finishBasin(opaque);

  // Hands over the water: the union of each hand's capsules as a shadow that sharpens, darkens and
  // slides in under the hand as it comes down (the window is up and to the left, so a raised part's
  // shadow falls down and to the right), and a bright meniscus ring around the wet part of every
  // capsule that breaks the surface, with the surface climbing the solid so the reflection catches.
  float shade = 1.0, ringLit = 0.0, ringBand = 0.0;
  vec2 ringTilt = vec2(0.0);
  for (int i = 0; i < ${MAX_HANDS}; i++) {
    if (i >= u_shadowCount) break;
    vec4 hb = u_shadowHands[i];
    if (distance(g, hb.xy) > hb.z) continue;
    int first = int(u_shadowMeta[i].x + 0.5), count = int(u_shadowMeta[i].y + 0.5);
    float cov = 0.0, ringD = 1e9, ringWet = 0.0;
    vec2 ringDir = vec2(0.0);
    for (int k = 0; k < ${MAX_SHADOW_CAPSULES}; k++) {
      if (k >= count) break;
      vec4 c = u_capSeg[first + k]; vec4 cm = u_capMeta[first + k];
      float r = cm.x, hA = cm.y, hB = cm.z;
      vec2 a = c.xy + LIGHT_SHIFT * (max(hA, 0.0) / u_domain), b = c.zw + LIGHT_SHIFT * (max(hB, 0.0) / u_domain);
      float t; float dist = segDist(g, a, b, t);
      float h = max(mix(hA, hB, t), 0.0);
      float core = r * 0.85, pen = PEN_BASE + h * PEN_H;
      float disc = 1.0 - smoothstep(core, core + pen, dist);
      // The floor is nearly black, so the shadow stays fairly dark even when the hand is high; its
      // softness and displacement are what read as height.
      cov = max(cov, disc * (0.45 + 0.2 / (1.0 + h * 4.0)) * abs(cm.w));
      float hmin = min(hA, hB);
      if (hmin < 0.0 && cm.w > 0.0) {
        // The wet part of the axis (underside below the surface) and the cross-section at the surface.
        float ry = r * u_domain;
        float tA = 0.0, tB = 1.0;
        if (max(hA, hB) > 0.0) { float tc = -hA / (hB - hA); if (hA < 0.0) tB = tc; else tA = tc; }
        vec2 wa = c.xy + (c.zw - c.xy) * tA, wb = c.xy + (c.zw - c.xy) * tB;
        float hAxis = max(hmin + ry, 0.0) / ry;
        float rw = r * sqrt(max(1.0 - hAxis * hAxis, 0.0));
        float tw; float wd = segDist(g, wa, wb, tw);
        // The signed distance to the union of the hand's wet stadiums: the ring sits on its outline, so a
        // plunged fist gets one round ring and five dipped fingertips five small ones.
        float dr = wd - rw;
        if (dr < ringD) { ringD = dr; ringDir = (g - mix(wa, wb, tw)) / max(wd, 1e-5); ringWet = smoothstep(0.0, 0.06, -hmin / (2.0 * ry)); }
      }
    }
    shade *= 1.0 - cov * hb.w;
    if (ringD < 1e8) {
      float wet = ringWet * hb.w;
      ringLit += exp(-ringD * ringD / (0.006 * 0.006)) * wet * (0.06 + 0.94 * max(0.0, dot(ringDir, L2)));
      float band = exp(-ringD * ringD / (0.012 * 0.012)) * wet;
      ringBand += band; ringTilt += ringDir * band;
    }
  }
  // The scan: every scanned cell's solid casts its shadow at its (x, z), slid and softened by its
  // height; a pixel is in shadow when some cell in the column that would shade it covers this depth.
  if (u_surfaceReady == 1 && u_scan.w > 0.001 && distance(g, u_scan.xy) <= u_scan.z) {
    float cov = 0.0;
    for (int k = 0; k < ${SCAN_SHADOW_ROWS}; k++) {
      float y = u_scanRows.x + (float(k) + 0.5) / ${SCAN_SHADOW_ROWS}.0 * u_scanRows.y;
      float h = max(y - u_scanRows.z, 0.0);
      vec2 gs = g - LIGHT_SHIFT * (h / u_domain);
      float pen = PEN_BASE + h * PEN_H;
      vec2 xy = vec2(gs.x * u_scanMap.x + u_scanMap.y, y);
      vec3 sc = scanSample(xy, max(pen * u_scanMap.x * 0.6, u_surfaceTexel.x));
      if (sc.y < 0.01) continue;
      float dz = gs.y * u_scanMap.z + u_scanMap.w - sc.x;
      float e = max(pen * u_domain, THICK * 0.2);
      float m = sc.y;
      float body = smoothstep(-e, 0.0, dz) * (1.0 - smoothstep(THICK, THICK + e, dz));
      cov = max(cov, m * body * (0.45 + 0.2 / (1.0 + h * 4.0)));
    }
    shade *= 1.0 - cov * u_scan.w;
    if (u_scanRows.w > 0.001) {
      float e = 0.004;
      float f = scanWaterline(g), fx = scanWaterline(g + vec2(e, 0.0)), fy = scanWaterline(g + vec2(0.0, e));
      vec2 grad = vec2(fx - f, fy - f);
      float band = pow(4.0 * f * (1.0 - f), 2.5) * u_scanRows.w;
      vec2 wdir = -grad / max(length(grad), 1e-5);
      ringLit += band * (0.06 + 0.94 * max(0.0, dot(wdir, L2)));
      ringBand += band; ringTilt += wdir * band;
    }
  }

  // Surface geometry comes from a separate damped wave field. Pigment is below it.
  vec2 e = u_waveTexel;
  float h = waveHeight(u_wave, g);
  float hL = waveHeight(u_wave, g - vec2(e.x, 0)), hR = waveHeight(u_wave, g + vec2(e.x, 0));
  float hB = waveHeight(u_wave, g - vec2(0, e.y)), hT = waveHeight(u_wave, g + vec2(0, e.y));
  vec2 slope = vec2(hR - hL, hT - hB) / (2.0 * e);
  vec3 n = normalize(vec3(-slope, 1.0));
  float men = smoothstep(R - 0.018, R, d);
  n = normalize(mix(n, vec3(dir * 0.65, 0.65), men));
  n = normalize(mix(n, vec3(ringTilt * 0.7, 0.6), min(ringBand * 0.65, 1.0)));
  vec3 rr = reflect(-V, n);
  float fres = 0.0204 + 0.9796 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 reflected = waterEnvironment(rr) * fres * u_light;

  // Snell refraction through a shallow water layer. Floor and ink share the
  // displaced coordinate so highlights slide over pigment, rather than sticking to it.
  vec3 transmitted = refract(-V, n, 1.0 / 1.333);
  vec3 innerCentre = vec3(0, 0, 0.04 * scale);
  float innerZ = 0.24 * scale;
  float innerXY = R / sqrt(1.0 - pow(innerCentre.z / innerZ, 2.0));
  vec3 innerRadii = vec3(innerXY, innerXY, innerZ);
  vec3 underOrigin = waterPoint + transmitted * 0.0001;
  float floorT = ellipsoidRoots(underOrigin, transmitted, innerCentre, innerRadii).y;
  // A ripple at the boundary can put its ray just outside the inner bowl.
  // Shade the wet wall locally on a miss, never an extrapolated far-away point.
  if (floorT < 0.0 || floorT > 2.0 * R) floorT = 0.0;
  vec3 floorPoint = underOrigin + transmitted * floorT;
  vec3 floorNormal = -ellipsoidNormal(floorPoint, innerCentre, innerRadii);
  vec2 floorUV = floorPoint.xy + 0.5;
  vec3 dye = max(texture(u_dye, floorUV).rgb, vec3(0.0));
  float density = lum(dye);
  // Beer-Lambert absorption: complementary channels absorb, thick pigment darkens.
  vec3 absorption = (vec3(dye.r + dye.g + dye.b) - dye) * 3.2 + density * 0.45;
  vec3 transmission = exp(-absorption);
  vec3 lightUnder = -refract(-Ld, vec3(0, 0, 1), 1.0 / 1.333);
  vec3 ceramic = basinCeramic(floorPoint, floorNormal, (floorPoint - innerCentre) / innerRadii,
    -transmitted, lightUnder, R, scale);
  float focus = clamp(1.0 - (hL + hR + hB + hT - 4.0 * h) / (e.x * e.x) * 0.045, 0.5, 1.8);
  ceramic *= 0.9 + u_caustics * focus * 0.14;
  vec3 water = ceramic * transmission * exp(-vec3(0.32, 0.12, 0.055) * max(floorT, 0.0)) * shade;
  vec3 bowlCol = water * (1.0 - fres) + reflected;
  bowlCol += vec3(0.85, 0.92, 1.0) * ringLit * 0.13 * u_light;

  return finishBasin(bowlCol);
}
void main() {
  vec2 q = u_pixel * 0.25;
  vec4 color = shadeBasin(v_uv - q);
  // Spend extra samples only on porcelain edges. Interior ink stays sharp;
  // this is subpixel geometric coverage, with no image-wide blur or history.
  if (basinEdge) {
    color += shadeBasin(v_uv + vec2(q.x, -q.y));
    color += shadeBasin(v_uv + vec2(-q.x, q.y));
    color += shadeBasin(v_uv + q);
    color *= 0.25;
  }
  o = color;
}`;
