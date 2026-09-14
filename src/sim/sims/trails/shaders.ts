/**
 * GLSL for Afterglow. Full-screen passes use the shared fullscreen-triangle
 * vertex shader; strokes, floor pools and the ghost are instanced quads whose
 * corners come from `gl_VertexID` and whose instance data arrive as
 * attributes, so the fragment work stays proportional to what is painted.
 */
import { GLSL_HEADER } from '../../gl/program';
import { handSdfGlsl } from '../../gl/hand';
import { surfaceGlsl } from '../../gl/surface';

const COMMON = `
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float peak(vec3 c) { return max(c.r, max(c.g, c.b)); }
`;

/** Corner of a 4-vertex triangle strip from the vertex id: (0,0) (1,0) (0,1) (1,1). */
const QUAD_CORNER = `vec2 quadCorner() { return vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)); }`;

/** Decay the previous frame and subtract the black floor. Strokes and pools are blended on top of the result. */
export const DECAY_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_prev; uniform float u_decay, u_floor;
void main() { o = max(texture(u_prev, v_uv) * u_decay - u_floor, 0.0); }`;

/**
 * One stroke per instance: a capsule that moved from a0–b0 to a1–b1 on the
 * glass (uniform units, already projected), with the apparent brush radius.
 * The quad covers the bounding box of the four ends plus the radius.
 */
export const STROKE_VS = `${GLSL_HEADER}
in vec4 a_prev;   // a0.xy, b0.xy on the glass
in vec4 a_curr;   // a1.xy, b1.xy
in vec4 a_col;    // rgb premultiplied by amplitude, apparent radius
flat out vec4 v_prev, v_curr, v_col;
out vec2 v_p;
uniform float u_aspect;
${QUAD_CORNER}
void main() {
  vec2 lo = min(min(a_prev.xy, a_prev.zw), min(a_curr.xy, a_curr.zw)) - a_col.w;
  vec2 hi = max(max(a_prev.xy, a_prev.zw), max(a_curr.xy, a_curr.zw)) + a_col.w;
  vec2 p = mix(lo, hi, quadCorner());
  v_p = p; v_prev = a_prev; v_curr = a_curr; v_col = a_col;
  gl_Position = vec4(p.x / u_aspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Deposit over the area the capsule swept: full brush inside the quad
 * a0 b0 b1 a1 (both diagonals, so a rotating capsule leaves no hole), the
 * soft brush kernel beyond its nearest edge, plus a tighter warm-white core.
 * Deposits saturate against what is already there (the decayed previous
 * frame, sampled here) so overlaps bloom toward white gracefully; the pass is
 * blended additively onto the decayed buffer.
 */
export const STROKE_FS = `${GLSL_HEADER}${COMMON}
flat in vec4 v_prev, v_curr, v_col;
in vec2 v_p; out vec4 o;
uniform sampler2D u_prev;
uniform vec2 u_texel;
uniform float u_decay, u_floor, u_headK;
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a; float l2 = dot(ab, ab);
  float t = l2 > 1e-12 ? clamp(dot(p - a, ab) / l2, 0.0, 1.0) : 0.0;
  return distance(p, a + ab * t);
}
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
bool insideTri(vec2 p, vec2 a, vec2 b, vec2 c) {
  if (abs(cross2(b - a, c - a)) < 1e-9) return false;   // a degenerate triangle contains nothing: a point brush paints no plateau
  float s1 = cross2(b - a, p - a), s2 = cross2(c - b, p - b), s3 = cross2(a - c, p - c);
  return (s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0);
}
void main() {
  vec2 a0 = v_prev.xy, b0 = v_prev.zw, a1 = v_curr.xy, b1 = v_curr.zw;
  float d = 0.0;
  if (!(insideTri(v_p, a0, b0, b1) || insideTri(v_p, a0, b1, a1) || insideTri(v_p, a0, b0, a1) || insideTri(v_p, b0, b1, a1)))
    d = min(min(segDist(v_p, a0, b0), segDist(v_p, a1, b1)), min(segDist(v_p, a0, a1), segDist(v_p, b0, b1)));
  d /= max(v_col.w, 1e-5);
  if (d >= 1.0) discard;
  float w = 1.0 - d * d; w = w * w * w;
  vec3 add = v_col.rgb * w + vec3(peak(v_col.rgb) * 0.35) * (w * w * w);
  vec3 old = max(texture(u_prev, gl_FragCoord.xy * u_texel).rgb * u_decay - u_floor, 0.0);
  o = vec4(add * exp(-u_headK * peak(old)), 0.0);
}`;

/**
 * Floor pools, one per instance: centre on the glass, apparent half-width and
 * amplitude. The pool lies on the floor (y = 0), whose screen height alone
 * gives the perspective scale there: cy = (1 − scale) / 2; a disc on the floor
 * is foreshortened to an ellipse scale / (2 eye) as tall as it is wide.
 */
export const POOL_VS = `${GLSL_HEADER}
in vec4 a_pool;   // cx, cy on the glass, apparent half-width, amplitude
flat out vec4 v_pool; flat out float v_ry;
out vec2 v_p;
uniform float u_aspect, u_eye;
${QUAD_CORNER}
void main() {
  float scale = max(1.0 - 2.0 * a_pool.y, 1e-3);
  float ry = max(a_pool.z * 0.5 * scale / u_eye, 1e-5);
  vec2 p = a_pool.xy + (quadCorner() * 2.0 - 1.0) * vec2(a_pool.z, ry);
  v_p = p; v_pool = a_pool; v_ry = ry;
  gl_Position = vec4(p.x / u_aspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`;

/** The pool is a second, monochrome accumulation in the alpha channel, saturating like the colour. */
export const POOL_FS = `${GLSL_HEADER}
flat in vec4 v_pool; flat in float v_ry;
in vec2 v_p; out vec4 o;
uniform sampler2D u_prev;
uniform vec2 u_texel;
uniform float u_decay, u_floor, u_headK;
void main() {
  vec2 e = (v_p - v_pool.xy) / vec2(max(v_pool.z, 1e-5), v_ry);
  float d2 = dot(e, e);
  if (d2 >= 1.0) discard;
  float pw = 1.0 - d2;
  float old = max(texture(u_prev, gl_FragCoord.xy * u_texel).a * u_decay - u_floor, 0.0);
  o = vec4(0.0, 0.0, 0.0, v_pool.w * pw * pw * exp(-u_headK * old));
}`;

/**
 * The ghost: a quad over each hand's bounding sphere (or the scan's bounding
 * circle at the glass), inside which the window camera's ray is marched
 * against the solid. Drawn additively over the composited picture.
 */
export const GHOST_VS = `${GLSL_HEADER}
in vec4 a_bound;  // world centre xyz, radius
out vec2 v_ndc;
uniform mat4 u_matrix;
uniform float u_aspect, u_eye;
${QUAD_CORNER}
void main() {
  vec4 clip = u_matrix * vec4(a_bound.xyz, 1.0);
  vec2 c = clip.xy / max(clip.w, 1e-4);
  float s = u_eye / (u_eye + max(a_bound.z - a_bound.w, 0.0));   // perspective scale at the sphere's nearest point
  vec2 h = a_bound.w * s * 1.15 / vec2(u_aspect * 0.5, 0.5);
  v_ndc = c + h * (quadCorner() * 2.0 - 1.0);
  gl_Position = vec4(v_ndc, 0.0, 1.0);
}`;

/** Rim-lit, translucent: bright at grazing angles, quiet face-on, dimmer deeper in. Mode 1 marches the scanned surface, mode 0 the capsule field. */
export const GHOST_FS = `${GLSL_HEADER}
in vec2 v_ndc; out vec4 o;
uniform float u_aspect, u_depth, u_eye, u_ghost;
uniform int u_mode;
uniform vec3 u_color;
${handSdfGlsl()}
${surfaceGlsl()}
vec3 handNormal(vec3 p) {
  vec2 e = vec2(0.004, 0.0);
  return normalize(vec3(handDistance(p + e.xyy) - handDistance(p - e.xyy), handDistance(p + e.yxy) - handDistance(p - e.yxy), handDistance(p + e.yyx) - handDistance(p - e.yyx)));
}
void main() {
  vec3 ro = vec3(u_aspect * 0.5, 0.5, -u_eye);
  vec3 rd = normalize(vec3(v_ndc.x * u_aspect * 0.5, v_ndc.y * 0.5, u_eye));
  vec3 q, n;
  if (u_mode == 1) {
    vec4 hit = surfaceHit(ro, rd, u_depth, 40);
    if (hit.w < 0.5) discard;
    q = hit.xyz; n = surfaceNormal(vec2(q.x / u_surfaceAspect, q.y));
  } else {
    vec2 span = handBoundsHit(ro, rd);
    if (span.y <= max(span.x, 0.0)) discard;
    float t = max(span.x, 0.0), tEnd = span.y, hit = -1.0;
    for (int i = 0; i < 32; i++) {
      vec3 p = ro + rd * t;
      float d = handDistance(p);
      if (d < 0.002) { hit = t; break; }
      t += max(d, 0.003);
      if (t > tEnd) break;
    }
    if (hit < 0.0) discard;
    q = ro + rd * hit; n = handNormal(q);
  }
  float rim = pow(1.0 - abs(dot(n, -rd)), 2.0);
  float depth01 = clamp(q.z / u_depth, 0.0, 1.0);
  vec3 c = mix(u_color, vec3(1.0), 0.5) * (0.05 + 0.55 * rim) * u_ghost / (1.0 + 0.9 * depth01);
  o = vec4(c, 0.0);
}`;

/** Sparkles: additive point sprites drawn over the composited picture. Positions are world units in the volume; the window camera projects them. */
export const POINTS_VS = `${GLSL_HEADER}
in vec3 a_pos; in float a_size; in vec3 a_col;
out vec3 v_col;
uniform mat4 u_matrix;
uniform float u_eye, u_pointScale;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  float scale = u_eye / (u_eye + a_pos.z);   // apparent size shrinks with depth
  gl_PointSize = max(1.5, a_size * u_pointScale * scale);
  v_col = a_col;
}`;

export const POINTS_FS = `${GLSL_HEADER}
in vec3 v_col; out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 >= 1.0) discard;
  // Bright pin-point with a soft skirt.
  float w = 1.0 - r2;
  w = w * w * (0.35 + 0.65 * w * w);
  o = vec4(v_col * w, 1.0);
}`;

/** Bloom prefilter: 4 bilinear taps (a 4×4 box at quarter resolution) with a soft threshold that keeps colour ratios. */
export const DOWNSAMPLE_FS = `${GLSL_HEADER}${COMMON}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_texel; uniform float u_exposure, u_threshold;
void main() {
  vec3 c = texture(u_src, v_uv + u_texel * vec2(-1.0, -1.0)).rgb + texture(u_src, v_uv + u_texel * vec2(1.0, -1.0)).rgb
         + texture(u_src, v_uv + u_texel * vec2(-1.0, 1.0)).rgb + texture(u_src, v_uv + u_texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25 * u_exposure;
  float l = peak(c);
  o = vec4(c * (max(l - u_threshold, 0.0) / max(l, 1e-4)), 1.0);
}`;

/** Separable Gaussian, 9 bilinear fetches ≈ 17 taps, sigma ≈ 3.5 texels. `u_dir` is direction × texel × spread. */
export const BLUR_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_dir;
void main() {
  vec3 c = texture(u_src, v_uv).rgb * 0.2074;
  c += (texture(u_src, v_uv + u_dir * 1.5).rgb + texture(u_src, v_uv - u_dir * 1.5).rgb) * 0.1891;
  c += (texture(u_src, v_uv + u_dir * 3.5).rgb + texture(u_src, v_uv - u_dir * 3.5).rgb) * 0.1259;
  c += (texture(u_src, v_uv + u_dir * 5.5).rgb + texture(u_src, v_uv - u_dir * 5.5).rgb) * 0.0603;
  c += (texture(u_src, v_uv + u_dir * 7.5).rgb + texture(u_src, v_uv - u_dir * 7.5).rgb) * 0.0209;
  o = vec4(c, 1.0);
}`;

/**
 * Final image: exposure, bloom, the floor pool (accumulation alpha, coloured and gated by presence), filmic tone-map, gamma,
 * a little grain in lit areas, and a 1-LSB dither so fades do not band.
 * `u_time` seeds the grain and must be wrapped by the caller (it is hashed in fp32, which loses the fractional bits after hours of uptime).
 */
export const COMPOSITE_FS = `${GLSL_HEADER}${COMMON}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_accum, u_bloom;
uniform float u_exposure, u_bloomAmount, u_grain, u_time, u_pool;
uniform vec3 u_poolColor;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec4 acc = texture(u_accum, v_uv);
  vec3 hdr = acc.rgb * u_exposure + texture(u_bloom, v_uv).rgb * u_bloomAmount + u_poolColor * (acc.a * u_exposure * u_pool);
  vec3 c = aces(hdr);
  // Dim light leans into its hue (deep amber, rose) instead of fading through brown-grey.
  float lin = luma(c);
  c = max(mix(vec3(lin), c, 1.0 + 0.5 * (1.0 - smoothstep(0.0, 0.45, lin))), 0.0);
  c = pow(c, vec3(1.0 / 2.2));
  float l = luma(c);
  float n = hash(gl_FragCoord.xy + vec2(fract(u_time * 7.31) * 101.0, fract(u_time * 3.17) * 57.0));
  c += (n - 0.5) * (u_grain * 0.08 * l * (1.0 - l) + 1.0 / 255.0);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/** 16×16 probe: each texel averages a 4×4 grid of taps over its cell. R = mean displayed luminance, G = lit fraction. */
export const PROBE_FS = `${GLSL_HEADER}${COMMON}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform float u_exposure, u_threshold, u_cell;
void main() {
  float sum = 0.0, lit = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 uv = v_uv + (vec2(float(i), float(j)) - 1.5) * (u_cell * 0.25);
    float l = luma(aces(texture(u_src, uv).rgb * u_exposure));
    sum += l; lit += step(u_threshold, l);
  }
  o = vec4(sum / 16.0, lit / 16.0, 0.0, 1.0);
}`;
