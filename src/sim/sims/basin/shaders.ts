/**
 * Basin — GLSL. Stable-fluids passes on a square grid (uv ∈ [0,1]², velocity
 * in uv/s), a 16×16 probe, and the composite. Signed quantities go through
 * `readV/packV` (vec2) and `readS/packS` (float) so an RGBA8 fallback still
 * runs: with PACKED defined they are offset-encoded around 128/255.
 */
import { GLSL_HEADER } from '../../gl/program';
import { CAUSTIC_LACUNARITY, CAUSTIC_PERIOD, PACKED_VELOCITY_SCALE, PROBE_ENC, PROBE_SIZE, PROBE_SUB } from './model';

export const MAX_HANDS = 4;
export const MAX_DROPS = 4;

const prelude = (packed: boolean) => `${GLSL_HEADER}
${packed ? '#define PACKED 1' : ''}
in vec2 v_uv; out vec4 o;
uniform vec2 u_texel;
uniform float u_bowl;
float bowlDist(vec2 uv) { return length(uv - 0.5); }
float hardMask(vec2 uv) { return step(bowlDist(uv), u_bowl); }
float softMask(vec2 uv) { return 1.0 - smoothstep(u_bowl - 2.5 * u_texel.x, u_bowl, bowlDist(uv)); }
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
 * Advect velocity (semi-Lagrangian), dissipate, then add hand drag, radial presses, drop impulses and a slow drift.
 * `u_driftPhase` holds the four drift phases in cycles, already reduced modulo 1 (see model.ts `driftPhases`).
 */
export const advectVelocity = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_velocity;
uniform float u_dt, u_decay, u_decayFloor, u_drift, u_couple;
uniform vec4 u_driftPhase;
uniform int u_handCount;
uniform vec4 u_hands[${MAX_HANDS}];     // x, y, vx, vy (grid uv, uv/s)
uniform vec4 u_handMeta[${MAX_HANDS}];  // radius, coupling, radial press (uv/s²), 0
uniform int u_dropCount;
uniform vec4 u_drops[${MAX_DROPS}];     // x, y, radius, impulse (uv/s)
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
  for (int i = 0; i < ${MAX_HANDS}; i++) {
    if (i >= u_handCount) break;
    vec4 h = u_hands[i]; vec4 m = u_handMeta[i];
    vec2 d = uv - h.xy;
    float q = dot(d, d) / (m.x * m.x);
    float g = exp(-q * 2.0);
    // The water under the hand relaxes toward the hand's velocity (bounded, stable).
    v += (h.zw * m.y - v) * g * u_couple;
    // Pressing in pushes water outward in a ring around the hand.
    float len = length(d) + 1e-5;
    v += (d / len) * m.z * exp(-q * 1.2) * min(sqrt(q), 1.0) * u_dt;
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

/** Advect the dye, dissipate, and add this step's ink drops. */
export const advectDye = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_dye, u_velocity;
uniform float u_dt, u_fade, u_fadeFloor;
uniform int u_dropCount;
uniform vec4 u_drops[${MAX_DROPS}];      // x, y, radius, amount
uniform vec3 u_dropColor[${MAX_DROPS}];
void main() {
  vec2 uv = v_uv;
  vec2 v = readV(u_velocity, uv);
  vec3 dye = texture(u_dye, uv - v * u_dt).rgb;
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
    float g = exp(-q * q * 1.2) * 0.7 + exp(-q * 1.2) * 0.3;
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
 * Composite: dark water over a shadowed bowl floor with faint caustics, ink
 * from the dye field, a fake surface normal (ink density + vortex dimples)
 * that catches the reflection of a window, a meniscus at the wall, and a thin
 * ceramic lip outside. Runs once at canvas resolution.
 */
export const composite = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_dye, u_velocity, u_pressure;
uniform vec2 u_pixel, u_dyeTexel;
uniform float u_aspect, u_domain, u_light, u_caustics, u_presence;
// Caustic scroll offsets in lattice units, each in [0, HASH_PERIOD): layer a in xy, layer b in zw;
// u_caustT for the first value-noise octave, u_caustT2 for the second (see model.ts causticOffsets).
uniform vec4 u_caustT, u_caustT2;

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

void main() {
  vec2 u = vec2(v_uv.x * u_aspect, v_uv.y);
  vec2 g = (u - vec2(u_aspect * 0.5, 0.5)) / u_domain + 0.5;
  vec2 rel = g - 0.5;
  float d = length(rel);
  vec2 dir = rel / max(d, 1e-5);
  float R = u_bowl;
  float px = u_pixel.y / u_domain;
  float inside = 1.0 - smoothstep(R - px, R + px, d);

  // Dye: centre plus a cross two dye texels out (halo and a smooth gradient).
  vec2 t = u_dyeTexel;
  vec3 dC = texture(u_dye, g).rgb;
  vec3 dL = texture(u_dye, g - vec2(2.0 * t.x, 0.0)).rgb, dR = texture(u_dye, g + vec2(2.0 * t.x, 0.0)).rgb;
  vec3 dB = texture(u_dye, g - vec2(0.0, 2.0 * t.y)).rgb, dT = texture(u_dye, g + vec2(0.0, 2.0 * t.y)).rgb;
  vec3 softDye = (dL + dR + dB + dT) * 0.25;
  float hC = lum(dC);
  // The surface: pressure is smooth by construction and low at vortex cores, which dimple the
  // water; ink density adds a little relief so filaments catch glints.
  vec2 s = u_texel * 3.5;
  float pL = readS(u_pressure, g - vec2(s.x, 0.0)), pR = readS(u_pressure, g + vec2(s.x, 0.0));
  float pB = readS(u_pressure, g - vec2(0.0, s.y)), pT = readS(u_pressure, g + vec2(0.0, s.y));
  vec2 v = readV(u_velocity, g);

  vec2 grad = vec2(lum(dR) - lum(dL), lum(dT) - lum(dB)) * 0.5 + vec2(pR - pL, pT - pB) * 0.1 + v * 0.06;
  vec3 n = normalize(vec3(-grad, 1.0));
  float men = smoothstep(R - 0.028, R, d);
  n = normalize(mix(n, vec3(dir * 0.9, 0.42), men));

  // A camera above the bowl; a window up and to the left whose reflection lands inside the bowl.
  vec3 V = normalize(vec3(-rel * 1.2, 1.0));
  vec3 Ld = normalize(vec3(-0.16, 0.21, 0.96));
  vec2 L2 = normalize(Ld.xy);
  vec3 rr = reflect(-V, n);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
  float rl = max(dot(rr, Ld), 0.0);
  float win = pow(rl, 220.0), core = pow(rl, 1600.0);
  vec3 sky = vec3(0.07, 0.10, 0.15) * (0.45 + 0.55 * rr.y);
  vec3 window = vec3(0.96, 0.98, 1.0) * (win * 4.5 + core * 28.0) * u_light;
  vec3 reflected = (sky + window) * fres;
  // The meniscus catches the window as a thin arc on the lit side of the wall.
  float arc = exp(-pow((R - d - 0.004) / 0.005, 2.0)) * (0.1 + 0.9 * max(0.0, dot(dir, L2)));
  reflected += vec3(0.85, 0.9, 1.0) * arc * 0.4 * u_light;

  // Caustics on the floor: fine light webs, refracted through the surface and dragged by the flow.
  vec2 refr = n.xy * 0.05;
  float ca = causticLayer((g + refr) * 11.0 + v * 0.3, u_caustT.xy, u_caustT2.xy);
  float cb = causticLayer((g - refr * 0.7) * 14.0 + 5.7 - v * 0.22, u_caustT.zw, u_caustT2.zw);
  float caustic = (ca * cb * 4.0 + (ca + cb) * 0.03) * u_caustics;

  // Ink: dense cores saturate toward the palette colour and darken slightly; thin skirts are faint.
  vec3 ink = (1.0 - exp(-dC * 2.4)) / (1.0 + hC * 0.45);
  vec3 halo = 1.0 - exp(-softDye * 0.5);
  vec3 inkCol = ink * 0.75 + halo * 0.12;
  float shadow = 1.0 - 0.8 * (1.0 - exp(-hC * 3.0));

  // Floor and water.
  float wall = exp(-(R - d) / 0.035);
  vec3 floorCol = vec3(0.007, 0.013, 0.022) * (1.0 - 0.3 * smoothstep(0.0, R, d));
  floorCol += vec3(0.30, 0.50, 0.60) * caustic * 0.06;
  floorCol *= shadow;
  vec3 water = (floorCol + inkCol) * (1.0 - 0.8 * wall);
  vec3 bowlCol = water * (1.0 - fres) + reflected;
  // Glints where ink filaments ripple the surface.
  bowlCol += vec3(0.95, 0.97, 1.0) * core * u_light * 0.2 * min(hC * 2.0, 1.0);

  // Outside: a dark table, a soft shadow hugging the bowl, and a thin lit ceramic lip.
  float lipDist = d - R;
  float lip = exp(-pow((lipDist - 0.0035) / 0.0032, 2.0));
  float lipLight = 0.2 + 0.8 * max(0.0, dot(dir, L2));
  vec3 lipCol = vec3(0.22, 0.21, 0.20) * lipLight * lip;
  float ao = 1.0 - 0.7 * exp(-max(lipDist, 0.0) / 0.04);
  vec3 table = vec3(0.016, 0.015, 0.017) * ao * (0.75 + 0.25 * dot(dir, L2));
  vec3 outside = table + lipCol;

  vec3 col = mix(outside, bowlCol, inside);
  vec2 q = v_uv - 0.5; q.x *= u_aspect;
  col *= 1.0 - 0.45 * smoothstep(0.35, 0.95, length(q));
  col = col / (1.0 + col * 0.25);
  o = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}`;
