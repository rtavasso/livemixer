/**
 * Shallows — GLSL. Three programs over one field texture holding the surface
 * height h and its rate h_t (RGBA16F/32F, or two signed 16-bit values packed
 * into RGBA8 when no float target exists):
 *
 *   wave       one solver substep (model.ts has the equation and its bounds);
 *              the first substep of a fixed step also applies the stamps.
 *   probe      16×16 reduction for the signals.
 *   composite  the picture: straight down through the surface onto a sand bed.
 *
 * Optics in the composite, all from the height field: the view ray is refracted
 * at the surface to find the bed point (small-slope Snell: the offset is
 * −depth · (1 − 1/n) · ∇h); sunlight refracted the same way maps the surface
 * onto the bed as q(p) = p − a ∇h(p), so the light arriving at the bed is the
 * inverse area ratio 1 / |det(I − a · Hessian h)|, which is what draws the
 * caustic lines where ripples focus. Red, green and blue bend by slightly
 * different amounts. Hands shade the bed with Basin's capsule/scan shadows,
 * evaluated at the refracted bed point so they wobble with the water.
 */
import { GLSL_HEADER } from '../../gl/program';
import { MATERIAL_GLSL } from '../../gl/material';
import { LIGHT_SHIFT, MAX_SHADOW_CAPSULES, PENUMBRA_BASE, PENUMBRA_PER_HEIGHT, SCAN_THICKNESS } from '../basin/model';
import { HEIGHT_RANGE, MAX_STAMPS, PROBE_ENC, PROBE_SIZE, PROBE_SUB, SWELL_WAVES, VELOCITY_RANGE } from './model';

export const MAX_HANDS = 4;
export const SCAN_SHADOW_ROWS = 32;
/** Height piled up ahead of a moving body per unit of its speed, relative to its radius. */
export const PUSH_GAIN = .3;
/** Sunlight's sideways travel between the surface and the bed, as a share of `LIGHT_SHIFT · depth` (refraction steepens the ray). */
export const BED_SHIFT = .75;

const prelude = (packed: boolean) => `${GLSL_HEADER}
${packed ? '#define PACKED 1' : ''}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_field;
uniform vec2 u_texel;
const float H_RANGE = ${HEIGHT_RANGE.toFixed(4)}, V_RANGE = ${VELOCITY_RANGE.toFixed(4)};
#ifdef PACKED
// Two signed 16-bit values with an exact zero, as bytes 0..255. Decoding is linear, so bilinear filtering stays valid.
// Rounding is symmetric about zero: a step of h_t · dt is often an exact half quantum, and rounding
// those all upward lifts the whole surface.
vec2 enc16(float x, float range) {
  float s = clamp(x / range, -1.0, 1.0) * 32767.0;
  float q = sign(s) * floor(abs(s) + 0.5) + 32768.0;
  return vec2(floor(q / 256.0), mod(q, 256.0)) / 255.0;
}
float dec16(vec2 bytes, float range) { return (dot(bytes, vec2(256.0, 1.0)) - 32768.0) * (range / 32767.0); }
vec2 unpackHV(vec4 bytes) { return vec2(dec16(bytes.rg, H_RANGE), dec16(bytes.ba, V_RANGE)); }
vec2 readHV(vec2 uv) { return unpackHV(texture(u_field, uv) * 255.0); }
// The solver reads whole texels: n/255 is not exact in a float, and the error is one-sided, so a filtered
// read at a texel centre decodes rest as slightly positive and the whole surface creeps upward.
vec2 fetchHV(ivec2 p) { return unpackHV(floor(texelFetch(u_field, clamp(p, ivec2(0), textureSize(u_field, 0) - 1), 0) * 255.0 + 0.5)); }
vec4 writeHV(float h, float v) { return vec4(enc16(h, H_RANGE), enc16(v, V_RANGE)); }
#else
vec2 readHV(vec2 uv) { return texture(u_field, uv).rg; }
vec2 fetchHV(ivec2 p) { return texelFetch(u_field, clamp(p, ivec2(0), textureSize(u_field, 0) - 1), 0).rg; }
vec4 writeHV(float h, float v) { return vec4(h, v, 0.0, 1.0); }
#endif
// Distance from p to the segment a–b, with the parameter t of the nearest point.
float segDist(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 ab = b - a, ap = p - a;
  float l2 = dot(ab, ab);
  t = l2 > 1e-12 ? clamp(dot(ap, ab) / l2, 0.0, 1.0) : 0.0;
  return length(ap - ab * t);
}
`;

/** Clear colour for a field at rest. */
export const restColor = (packed: boolean): [number, number, number, number] => packed ? [128 / 255, 0, 128 / 255, 0] : [0, 0, 0, 1];

/**
 * One substep. Edge texels repeat outward (clamped fetches), which is a zero-gradient wall: waves
 * reflect off the four screen edges and the sheet can slosh between them.
 */
export const wave = (packed: boolean) => `${prelude(packed)}
uniform float u_dx;        // plane units per cell
uniform float u_dt;        // substep
uniform float u_stepDt;    // the whole fixed step: stamps are applied once per step
uniform float u_c2, u_nu, u_damp, u_relax, u_aspect;
uniform int u_stampCount;
const int MAX_STAMPS = ${MAX_STAMPS};
uniform vec4 u_seg[MAX_STAMPS];    // a.xy, b.xy (plane)
uniform vec4 u_vel[MAX_STAMPS];    // velocity at a, at b (plane units/s)
uniform vec4 u_meta[MAX_STAMPS];   // radius, grip, vertical acceleration while gripped, impulse
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec2 c = fetchHV(t);
  vec2 side = fetchHV(t + ivec2(1, 0)) + fetchHV(t - ivec2(1, 0)) + fetchHV(t + ivec2(0, 1)) + fetchHV(t - ivec2(0, 1));
  vec2 diag = fetchHV(t + ivec2(1, 1)) + fetchHV(t - ivec2(1, 1)) + fetchHV(t + ivec2(1, -1)) + fetchHV(t + ivec2(-1, 1));
  // Isotropic nine-point Laplacian of h and of h_t.
  vec2 lap = (4.0 * side + diag - 20.0 * c) / (6.0 * u_dx * u_dx);
  float h = c.x;
  float v = (c.y + u_dt * (u_c2 * lap.x + u_nu * lap.y)) * u_damp;
  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y);
  for (int i = 0; i < MAX_STAMPS; i++) {
    if (i >= u_stampCount) break;
    vec4 m = u_meta[i];
    float t; float dist = segDist(p, u_seg[i].xy, u_seg[i].zw, t);
    float q = dist * dist / (m.x * m.x);
    if (q > 14.0) continue;
    vec2 d = p - mix(u_seg[i].xy, u_seg[i].zw, t);
    // A moving body piles water up ahead of itself and draws it down behind.
    h += u_stepDt * ${PUSH_GAIN.toFixed(3)} * m.y * dot(mix(u_vel[i].xy, u_vel[i].zw, t), d) / m.x * exp(-q);
    // Vertical pushes and one-off impulses: a dip ringed by a raised rim, so no water is created.
    float ring = (1.0 - q) * exp(-q);
    v += (u_stepDt * m.z * m.y + m.w) * ring;
  }
  v = clamp(v, -V_RANGE, V_RANGE);
  h = clamp((h + u_dt * v) * u_relax, -H_RANGE, H_RANGE);
  o = writeHV(h, v);
}`;

/** Per probe texel: mean height (signed), mean |h_t| and mean |∇²h| over SUB² samples of its part of the plane. */
export const probe = (packed: boolean) => `${prelude(packed)}
uniform float u_dx;
const int SIZE = ${PROBE_SIZE}; const int SUB = ${PROBE_SUB};
const float ENC_H = ${PROBE_ENC.height.toFixed(4)}, ENC_V = ${PROBE_ENC.speed.toFixed(4)}, ENC_C = ${PROBE_ENC.curvature.toFixed(4)};
void main() {
  vec2 cell = floor(v_uv * float(SIZE));
  float h = 0.0, speed = 0.0, curv = 0.0;
  for (int j = 0; j < SUB; j++) for (int i = 0; i < SUB; i++) {
    vec2 uv = (cell + (vec2(float(i), float(j)) + 0.5) / float(SUB)) / float(SIZE);
    vec2 c = readHV(uv);
    float around = readHV(uv + vec2(u_texel.x, 0.0)).x + readHV(uv - vec2(u_texel.x, 0.0)).x + readHV(uv + vec2(0.0, u_texel.y)).x + readHV(uv - vec2(0.0, u_texel.y)).x;
    h += c.x; speed += abs(c.y); curv += abs(around - 4.0 * c.x) / (u_dx * u_dx);
  }
  float k = 1.0 / float(SUB * SUB);
  o = vec4((128.0 + 127.0 * clamp(h * k / ENC_H, -1.0, 1.0)) / 255.0, clamp(speed * k / ENC_V, 0.0, 1.0), clamp(curv * k / ENC_C, 0.0, 1.0), 1.0);
}`;

export const composite = (packed: boolean) => `${prelude(packed)}
uniform sampler2D u_surface;
uniform vec2 u_cell;          // plane units per field texel, x and y
uniform float u_aspect, u_domain, u_depth, u_refraction, u_caustics, u_light, u_dispersion, u_absorb, u_texture;
uniform vec3 u_sand, u_water;
uniform int u_shadowCount;
uniform vec4 u_shadowHands[${MAX_HANDS}];          // bounding circle x, y, radius (grid uv), opacity 0..1 (fades after the hand leaves)
uniform vec4 u_shadowMeta[${MAX_HANDS}];           // first capsule, capsule count, 0, 0
uniform vec4 u_capSeg[${MAX_SHADOW_CAPSULES}];     // a.xy, b.xy (grid uv)
uniform vec4 u_capMeta[${MAX_SHADOW_CAPSULES}];    // radius (uv), underside clearance at a and at b (uniform units; < 0 in the water), weight (negative: shadow only)
uniform int u_surfaceReady;
uniform vec2 u_surfaceTexel;
uniform vec4 u_scanMap;      // grid uv → sim: x = uv.x * .x + .y, z = uv.y * .z + .w
uniform vec4 u_scanRows;     // sim y of the lowest scanned row, the row span, water level, wet gate for the ring
uniform vec4 u_scan;         // bounding circle x, y, radius (uv), opacity
const vec2 LIGHT_SHIFT = vec2(${LIGHT_SHIFT[0].toFixed(3)}, ${LIGHT_SHIFT[1].toFixed(3)});
const float PEN_BASE = ${PENUMBRA_BASE.toFixed(3)}, PEN_H = ${PENUMBRA_PER_HEIGHT.toFixed(3)};
const float THICK = ${SCAN_THICKNESS.toFixed(3)};
const float AMBIENT = 0.3;
${MATERIAL_GLSL}
float heightAt(vec2 uv) { return readHV(uv).x; }
vec2 slopeAt(vec2 uv) {
  return vec2(heightAt(uv + vec2(u_texel.x, 0.0)) - heightAt(uv - vec2(u_texel.x, 0.0)), heightAt(uv + vec2(0.0, u_texel.y)) - heightAt(uv - vec2(0.0, u_texel.y))) / (2.0 * u_cell);
}
vec2 planeToGrid(vec2 p) { return (p - vec2(0.5 * u_aspect, 0.5)) / u_domain + 0.5; }
// The scan across three columns ex apart: mask-weighted depth in x (so the blur never pulls in the back wall), mean mask in y.
vec3 scanSample(vec2 xy, float ex) {
  vec2 l = texture(u_surface, xy - vec2(ex, 0.0)).rg, c = texture(u_surface, xy).rg, r = texture(u_surface, xy + vec2(ex, 0.0)).rg;
  float w = l.g + c.g + r.g;
  return vec3((l.r * l.g + c.r * c.g + r.r * r.g) / max(w, 1e-4), w * (1.0 / 3.0), 0.0);
}
// The scan's wet coverage at a grid point, from the row at the water level: the waterline is its outline.
float scanWaterline(vec2 gp) {
  vec3 sc = scanSample(vec2(gp.x * u_scanMap.x + u_scanMap.y, u_scanRows.z), u_surfaceTexel.x);
  float dz = gp.y * u_scanMap.z + u_scanMap.w - sc.x;
  float e = max(PEN_BASE * u_domain, THICK * 0.2);
  return sc.y * smoothstep(-e, e, dz) * (1.0 - smoothstep(THICK - e, THICK + e, dz));
}

// Wind ripples (the Swell class in model.ts): analytic slope and curvature (xx, yy, xy) of a sum of travelling sines, gently
// warped so the crests wander instead of forming a lattice. The warp is slow, so its own derivatives are ignored.
const int SWELL = ${SWELL_WAVES.length};
uniform vec4 u_swell[SWELL];   // k.x, k.y, amplitude, phase
void swellAt(vec2 p, out vec2 g, out vec3 hs) {
  g = vec2(0.0); hs = vec3(0.0);
  vec2 q = p + 0.13 * (vec2(materialNoise(p * 1.1 + 3.0), materialNoise(p * 1.1 + 19.0)) - 0.5)
             + 0.04 * (vec2(materialNoise(p * 3.7 + 41.0), materialNoise(p * 3.7 + 67.0)) - 0.5);
  for (int i = 0; i < SWELL; i++) {
    vec4 w = u_swell[i];
    float ph = dot(w.xy, q) + w.w, sn = sin(ph) * w.z, cs = cos(ph) * w.z;
    g += cs * w.xy; hs -= sn * vec3(w.x * w.x, w.y * w.y, w.x * w.y);
  }
}
// The bed is not level: pools and bars a couple of screen heights across.
float bedDepth(vec2 p) {
  return u_depth * (0.62 + 0.5 * materialNoise(p * 0.8 + 7.3) + 0.26 * materialNoise(mat2(0.8, 0.6, -0.6, 0.8) * p * 1.9 + 1.7));
}

// Sand ripple marks as a height (0 trough … 1 crest): wandering, forking ridges with broad troughs, fading out in places.
float sandHeight(vec2 p) {
  vec2 w = p + 0.2 * (vec2(materialNoise(p * 1.3 + 11.0), materialNoise(p * 1.3 + 37.0)) - 0.5);
  float ph = dot(w, vec2(92.0, 38.0)) + 4.5 * materialNoise(p * 2.9 + 5.0);
  float crest = pow(0.5 + 0.5 * sin(ph), 1.7);
  return crest * mix(0.25, 1.0, smoothstep(0.2, 0.62, materialNoise(p * 0.75 + 23.0)));
}
// The bed at p: linear albedo, and how much sun it catches relative to level sand (ridge flanks facing the sun are brighter).
vec3 sandBed(vec2 p, vec3 sunDir, out float facing) {
  float px = max(fwidth(p.x), fwidth(p.y)), k = u_texture;
  float e = max(px * 1.5, 0.0012);
  float h0 = sandHeight(p);
  vec2 dh = vec2(sandHeight(p + vec2(e, 0.0)) - h0, sandHeight(p + vec2(0.0, e)) - h0) * (0.0075 / e);
  float coarse = 1.0 - smoothstep(0.004, 0.014, px);
  vec3 n = normalize(vec3(-dh * k * coarse, 1.0));
  facing = max(dot(n, sunDir), 0.0) / sunDir.z;
  float mottle = materialNoise(p * 3.3) * 0.6 + materialNoise(p * 9.0 + 11.0) * 0.4;
  vec3 albedo = u_sand * mix(1.0, 0.86 + 0.28 * mottle, min(k, 1.0));
  albedo *= mix(vec3(1.0), mix(vec3(1.05, 0.98, 0.9), vec3(0.94, 1.0, 1.05), materialNoise(p * 1.7 + 3.1)), 0.5 * min(k, 1.0));
  // Heavy dark minerals collect in the troughs; crests are washed pale.
  float trough = (1.0 - h0) * (1.0 - h0);
  albedo *= 1.0 - k * coarse * trough * (0.1 + 0.2 * materialNoise(p * 7.0 + 2.0));
  // Grain, fading before it would alias: two scales of speckle, dark grains (more of them in the troughs), bright quartz.
  float fine = 1.0 - smoothstep(0.0012, 0.0035, px);
  float grain = (materialNoise(p * 520.0) - 0.5) * 0.8 + (materialNoise(p * 230.0 + 5.0) - 0.5) * 0.5;
  albedo *= 1.0 + k * fine * 0.34 * grain;
  vec2 gp = p * 360.0, gc = floor(gp);
  float pick = materialHash(gc);
  vec2 go = fract(gp) - 0.3 - 0.4 * vec2(materialHash(gc + 5.0), materialHash(gc + 23.0));
  float speck = 1.0 - smoothstep(0.03, 0.07 + 0.16 * materialHash(gc + 41.0), dot(go, go));
  albedo *= 1.0 - k * fine * speck * 0.6 * step(0.985 - 0.03 * trough, pick);
  albedo *= 1.0 + k * fine * speck * 0.5 * step(pick, 0.006);
  // Pebbles and shell bits: sparse, small, at most one per cell of a turned lattice, half sunk in the sand.
  vec2 pp = mat2(0.839, 0.545, -0.545, 0.839) * p * 5.1 + 0.37;
  vec2 cell = floor(pp), f = fract(pp);
  if (materialHash(cell + 13.0) > 0.9) {
    float rad = 0.04 + 0.07 * materialHash(cell + 4.4) * materialHash(cell + 3.3);
    vec2 centre = rad + 0.05 + (1.0 - 2.0 * (rad + 0.05)) * vec2(materialHash(cell + 1.7), materialHash(cell + 9.2));
    float turn = 6.283 * materialHash(cell + 6.1);
    mat2 rot = mat2(cos(turn), sin(turn), -sin(turn), cos(turn));
    vec2 d = rot * (f - centre) * vec2(1.0, 1.0 + 0.35 * materialHash(cell + 8.8));
    d *= 1.0 + 0.22 * (materialNoise(f * 11.0 + cell) - 0.5);
    float r = length(d) / rad, edge = max(px * 5.1 * 1.5 / rad, 0.04);
    float body = (1.0 - smoothstep(1.0 - edge, 1.0 + edge, r)) * min(k, 1.0);
    vec3 tone = mix(vec3(0.1, 0.1, 0.105), vec3(0.4, 0.34, 0.28), materialHash(cell + 2.9));
    tone *= 0.75 + 0.5 * materialNoise(p * 90.0) * materialNoise(p * 31.0 + 3.0) * 2.0;
    vec2 sunLocal = rot * (mat2(0.839, 0.545, -0.545, 0.839) * normalize(sunDir.xy));
    float zz = sqrt(max(1.0 - r * r, 0.0));
    float dome = max(dot(normalize(vec3(d / rad * 0.9, zz + 0.35)), normalize(vec3(sunLocal * length(sunDir.xy), sunDir.z))), 0.0) / sunDir.z;
    vec2 away = (f - centre) + (mat2(0.839, 0.545, -0.545, 0.839) * normalize(sunDir.xy)) * rad * 0.45;
    float contact = (1.0 - smoothstep(0.75, 1.5, length(away) / rad)) * (1.0 - body);
    albedo *= 1.0 - 0.5 * min(k, 1.0) * contact;
    albedo = mix(albedo, tone, body); facing = mix(facing, dome, body);
  }
  return albedo;
}

void main() {
  vec2 P = vec2(v_uv.x * u_aspect, v_uv.y);
  vec2 L2 = normalize(-LIGHT_SHIFT);
  vec3 sunDir = normalize(vec3(-LIGHT_SHIFT, 1.0));
  vec2 swellSlope; vec3 swellCurve;
  swellAt(P, swellSlope, swellCurve);
  float h = heightAt(v_uv);
  vec2 slope = slopeAt(v_uv) + swellSlope;
  float depth = max(bedDepth(P) + h, 0.02);

  // Down through the surface: where this pixel's view ray meets the bed.
  vec2 bed = P - slope * (depth * 0.25 * u_refraction);
  // Sunlight reaches that bed point from a surface point up-sun of it, bent by the slope there. The light
  // arriving is the inverse of how much the refracted bundle is stretched: 1 / |det(I − a · Hessian)|.
  float a = depth * 0.8;
  vec2 src = bed - LIGHT_SHIFT * (depth * ${BED_SHIFT.toFixed(2)});
  vec2 cuv = vec2(src.x / u_aspect, src.y);
  src += (slopeAt(cuv) + swellSlope) * a;
  cuv = vec2(src.x / u_aspect, src.y);
  swellAt(src, swellSlope, swellCurve);
  vec2 ex = vec2(u_texel.x, 0.0), ey = vec2(0.0, u_texel.y);
  float hc = heightAt(cuv);
  float hxx = (heightAt(cuv + ex) + heightAt(cuv - ex) - 2.0 * hc) / (u_cell.x * u_cell.x) + swellCurve.x;
  float hyy = (heightAt(cuv + ey) + heightAt(cuv - ey) - 2.0 * hc) / (u_cell.y * u_cell.y) + swellCurve.y;
  float hxy = (heightAt(cuv + ex + ey) - heightAt(cuv - ex + ey) - heightAt(cuv + ex - ey) + heightAt(cuv - ex - ey)) / (4.0 * u_cell.x * u_cell.y) + swellCurve.z;
  vec3 ar = a * (1.0 + u_dispersion * vec3(-0.06, 0.0, 0.085));
  vec3 det = (1.0 - ar * hxx) * (1.0 - ar * hyy) - ar * ar * hxy * hxy;
  // The sun is a disc, not a point: that floors |det|, bounds the brightest line and keeps it from aliasing.
  vec3 focus = min(1.0 / sqrt(det * det + 0.006), vec3(6.0));
  vec3 caustic = mix(vec3(1.0), focus, u_caustics);

  // Hands over and in the water: shadows on the bed (at the point the light came through), and a lit
  // waterline ring on the surface around every part that breaks it.
  vec2 gB = planeToGrid(bed - LIGHT_SHIFT * (depth * ${BED_SHIFT.toFixed(2)})), gP = planeToGrid(P);
  float shade = 1.0, ringLit = 0.0;
  for (int i = 0; i < ${MAX_HANDS}; i++) {
    if (i >= u_shadowCount) break;
    vec4 hb = u_shadowHands[i];
    if (min(distance(gB, hb.xy), distance(gP, hb.xy)) > hb.z + 0.1) continue;
    int first = int(u_shadowMeta[i].x + 0.5), count = int(u_shadowMeta[i].y + 0.5);
    float cov = 0.0, ringD = 1e9, ringWet = 0.0;
    vec2 ringDir = vec2(0.0);
    for (int k = 0; k < ${MAX_SHADOW_CAPSULES}; k++) {
      if (k >= count) break;
      vec4 c = u_capSeg[first + k]; vec4 cm = u_capMeta[first + k];
      float r = cm.x, hA = cm.y, hB = cm.z;
      vec2 sa = c.xy + LIGHT_SHIFT * (max(hA, 0.0) / u_domain), sb = c.zw + LIGHT_SHIFT * (max(hB, 0.0) / u_domain);
      float t; float dist = segDist(gB, sa, sb, t);
      float hh = max(mix(hA, hB, t), 0.0) + depth;
      float core = r * 0.85, pen = PEN_BASE + hh * PEN_H;
      float disc = 1.0 - smoothstep(core, core + pen, dist);
      cov = max(cov, disc * (0.6 + 0.3 / (1.0 + hh * 4.0)) * abs(cm.w));
      float hmin = min(hA, hB);
      if (hmin < 0.0 && cm.w > 0.0) {
        // The wet part of the axis (underside below the surface) and the cross-section at the surface.
        float ry = r * u_domain;
        float tA = 0.0, tB = 1.0;
        if (max(hA, hB) > 0.0) { float tc = -hA / (hB - hA); if (hA < 0.0) tB = tc; else tA = tc; }
        vec2 wa = c.xy + (c.zw - c.xy) * tA, wb = c.xy + (c.zw - c.xy) * tB;
        float hAxis = max(hmin + ry, 0.0) / ry;
        float rw = r * sqrt(max(1.0 - hAxis * hAxis, 0.0));
        float tw; float wd = segDist(gP, wa, wb, tw);
        float dr = wd - rw;
        if (dr < ringD) { ringD = dr; ringDir = (gP - mix(wa, wb, tw)) / max(wd, 1e-5); ringWet = smoothstep(0.0, 0.06, -hmin / (2.0 * ry)); }
      }
    }
    shade *= 1.0 - cov * hb.w;
    if (ringD < 1e8) ringLit += exp(-ringD * ringD / (0.009 * 0.009)) * ringWet * hb.w * (0.12 + 0.88 * max(0.0, dot(ringDir, L2)));
  }
  // The scan: every scanned cell's solid casts its shadow at its (x, z), slid and softened by its height.
  if (u_surfaceReady == 1 && u_scan.w > 0.001 && min(distance(gB, u_scan.xy), distance(gP, u_scan.xy)) <= u_scan.z + 0.1) {
    float cov = 0.0;
    for (int k = 0; k < ${SCAN_SHADOW_ROWS}; k++) {
      float y = u_scanRows.x + (float(k) + 0.5) / ${SCAN_SHADOW_ROWS}.0 * u_scanRows.y;
      float hs = max(y - u_scanRows.z, 0.0);
      vec2 gs = gB - LIGHT_SHIFT * (hs / u_domain);
      float pen = PEN_BASE + (hs + depth) * PEN_H;
      vec3 sc = scanSample(vec2(gs.x * u_scanMap.x + u_scanMap.y, y), max(pen * u_scanMap.x * 0.6, u_surfaceTexel.x));
      if (sc.y < 0.01) continue;
      float dz = gs.y * u_scanMap.z + u_scanMap.w - sc.x;
      float e = max(pen * u_domain, THICK * 0.2);
      float body = smoothstep(-e, 0.0, dz) * (1.0 - smoothstep(THICK, THICK + e, dz));
      cov = max(cov, sc.y * body * (0.6 + 0.3 / (1.0 + (hs + depth) * 4.0)));
    }
    shade *= 1.0 - cov * u_scan.w;
    if (u_scanRows.w > 0.001) {
      float e = 0.004;
      float f = scanWaterline(gP), fx = scanWaterline(gP + vec2(e, 0.0)), fy = scanWaterline(gP + vec2(0.0, e));
      vec2 grad = vec2(fx - f, fy - f);
      ringLit += 0.5 * pow(4.0 * f * (1.0 - f), 2.5) * u_scanRows.w * (0.12 + 0.88 * max(0.0, dot(-grad / max(length(grad), 1e-5), L2)));
    }
  }

  // The lit bed: warm sun through the caustics, cool skylight filling the troughs and shadows.
  vec3 sun = vec3(1.0, 0.94, 0.84) * (0.9 * u_light);
  float facing;
  vec3 albedo = sandBed(bed, sunDir, facing);
  vec3 lit = albedo * (vec3(0.8, 0.93, 1.0) * (AMBIENT * u_light) + sun * ((1.0 - AMBIENT) * shade * facing) * caustic);
  // Back up through the water: Beer–Lambert over both legs, and light scattered in on the way, so pools run turquoise.
  vec3 through = pow(max(u_water, vec3(0.002)), vec3(depth * 2.1 * u_absorb));
  float haze = 1.0 - exp(-depth * 3.2 * u_absorb);
  vec3 color = mix(lit * through, u_water * sun * 1.5, haze * 0.35);

  // The surface itself: a faint sheen of sky seen from straight above, a little brighter where a slope faces the sun.
  vec3 n = normalize(vec3(-slope, 1.0));
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  float fresnel = 0.02 + 0.98 * pow(1.0 - n.z, 5.0);
  vec3 sky = mix(vec3(0.7, 0.8, 0.9), vec3(0.22, 0.4, 0.68), clamp(r.z * r.z, 0.0, 1.0)) * u_light;
  float toSun = max(dot(r, sunDir), 0.0);
  // Only a soft sheen: from straight above under a high sun, glitter would need slopes these waves rarely reach.
  float glint = pow(toSun, 160.0) * 0.5;
  color = mix(color, sky, fresnel) + sun * fresnel * glint * (0.35 + 0.65 * shade);
  color += vec3(0.9, 0.96, 1.0) * ringLit * u_light * 0.16;

  // The filmic curve washes out bright sand; give back a little of its colour first.
  color = max(mix(vec3(dot(color, vec3(0.3, 0.55, 0.15))), color, 1.22), vec3(0.0));
  vec2 q = v_uv - 0.5;
  o = vec4(filmicOutput(color * (1.0 - 0.3 * dot(q, q)), gl_FragCoord.xy), 1.0);
}`;
