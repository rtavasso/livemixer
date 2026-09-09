/** GLSL for Afterglow. All full-screen passes use the shared fullscreen-triangle vertex shader. */
import { GLSL_HEADER } from '../../gl/program';

const COMMON = `
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float peak(vec3 c) { return max(c.r, max(c.g, c.b)); }
`;

/**
 * Decay the previous frame, subtract the black floor, then deposit every
 * pending stroke segment with a distance-to-segment brush. Segments arrive
 * already projected onto the glass (uniform units, apparent radius), so this
 * pass is purely 2D. Deposits saturate against what is already there so
 * overlaps bloom toward white gracefully.
 *
 * The alpha channel is a second, monochrome accumulation: the pool of light
 * each segment casts on the floor of the volume, decayed the same way. The
 * composite colours it and gates it by presence.
 */
export function accumulateShader(maxSegments: number) {
  return `${GLSL_HEADER}${COMMON}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_prev;
uniform float u_decay, u_floor, u_aspect, u_headK, u_eye;
uniform int u_count;
uniform vec4 u_segPos[${maxSegments}];   // ax, ay, bx, by on the glass, uniform units
uniform vec4 u_segCol[${maxSegments}];   // rgb premultiplied by amplitude, apparent radius
uniform vec4 u_segPool[${maxSegments}];  // floor pool: cx, cy on the glass, apparent half-width, amplitude
void main() {
  vec4 old = max(texture(u_prev, v_uv) * u_decay - u_floor, 0.0);
  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y);
  vec3 add = vec3(0.0);
  float pool = 0.0;
  for (int i = 0; i < ${maxSegments}; i++) {
    if (i >= u_count) break;
    vec4 s = u_segPos[i]; vec4 c = u_segCol[i];
    vec2 ab = s.zw - s.xy;
    float len2 = dot(ab, ab);
    float t = len2 > 1e-10 ? clamp(dot(p - s.xy, ab) / len2, 0.0, 1.0) : 0.0;
    float d = distance(p, s.xy + ab * t) / max(c.w, 1e-5);
    if (d < 1.0) {
      float w = 1.0 - d * d; w = w * w * w;
      // Coloured brush plus a tighter warm-white core.
      add += c.rgb * w + vec3(peak(c.rgb) * 0.35) * (w * w * w);
    }
    vec4 f = u_segPool[i];
    // The pool lies on the floor (y = 0), whose screen height alone gives the perspective scale there: cy = (1 - scale) / 2.
    // A disc on the floor is foreshortened to an ellipse scale / (2 eye) as tall as it is wide.
    float scale = max(1.0 - 2.0 * f.y, 1e-3);
    vec2 e = (p - f.xy) / vec2(max(f.z, 1e-5), max(f.z * 0.5 * scale / u_eye, 1e-5));
    float d2 = dot(e, e);
    if (d2 < 1.0) { float pw = 1.0 - d2; pool += f.w * pw * pw; }
  }
  float head = exp(-u_headK * peak(old.rgb));
  float poolHead = exp(-u_headK * old.a);
  o = vec4(old.rgb + add * head, old.a + pool * poolHead);
}`;
}

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
