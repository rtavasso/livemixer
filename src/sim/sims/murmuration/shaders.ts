/** Murmuration shaders: streaked mote sprites, trail decay, glow, ghost-frame composite. */
import { GLSL_HEADER } from '../../gl/program';
import { ghostFrameGlsl } from '../living';

/**
 * One mote per instance, drawn as a short streak from where it was at the last frame to where it
 * is now (so the trail is continuous at any frame rate): a_mote = (uv x, uv y, depth 0 far … 1
 * near, brightness), a_prev = uv at the previous frame.
 *
 * `u_depth` (the perspective param; 0 = flat) turns the depth into a picture: far motes contract toward the centre of the
 * active area and near ones spread (so a folding sheet turns in space and a halo reads as a tilted
 * ring), sizes spread, far motes fade into the dark and go soft (depth of field: a larger, dimmer
 * sprite of the same energy). `u_shimmer` is the banking glint: a mote heading toward the sun
 * direction catches the light, one heading away dims, so waves of light run through a turning
 * sheet. `u_hue` grades far motes toward dusk and tints the glint rose.
 * `u_musicShimmer` (from the melodic parts in Live) runs a slow band of light through the flock on top
 * of all that, with `u_phase` as its clock.
 */
export const MOTE_VS = `${GLSL_HEADER}
in vec4 a_mote;
in vec2 a_prev;
uniform vec2 u_px, u_centre, u_sun;
uniform float u_size, u_gain, u_maxStreak, u_depth, u_shimmer, u_hue, u_musicShimmer, u_phase;
uniform vec3 u_color, u_cool, u_rose, u_dusk, u_glint;
out vec3 v_col;
out vec2 v_local;
out float v_len, v_r, v_soft;
vec2 project(vec2 uv, float z) {
  // Perspective about the picture plane (depth 0.5): 0.85x at the far end, 1.18x at the near end.
  return u_centre + (uv - u_centre) / (1.0 + u_depth * 0.35 * (0.5 - z));
}
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  float z = clamp(a_mote.z, 0.0, 1.0);
  float far = 1.0 - z;
  // Parallax: nearer motes are larger and brighter; depth widens the range.
  float s = u_size * mix(0.5 + 0.9 * z, 0.32 + 1.45 * z * z + 0.25 * z, u_depth);
  // Depth of field: a far mote is drawn larger and softer, with the same energy.
  float soft = u_depth * far * far;
  float drawn = max(s * (1.0 + 1.3 * soft), 1.5);
  float r = drawn * 0.5;
  vec2 b = project(a_mote.xy, z) * u_px, a = project(a_prev, z) * u_px, d = b - a;
  float len = length(d);
  // A jump (reset, count change) draws a dot; a slow frame draws a capped streak ending at the mote.
  if (len > 8.0 * u_maxStreak) { a = b; d = vec2(0.0); len = 0.0; }
  else if (len > u_maxStreak) { a = b - d * (u_maxStreak / len); len = u_maxStreak; }
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
  float along = corner.x < 0.0 ? -r : len + r, across = corner.y * r;
  vec2 p = a + dir * along + nrm * across;
  gl_Position = vec4(p / u_px * 2.0 - 1.0, 0.0, 1.0);
  v_local = vec2(along, across); v_len = len; v_r = r; v_soft = soft;
  // A sprite enlarged past its size (minimum size, depth of field) keeps the energy of the smaller one.
  float energy = (s * s) / (drawn * drawn);
  float h = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
  // Faint cool tint on the far motes and a few others; with u_hue, far motes go to dusk.
  float cool = clamp(0.1 + 0.45 * far + 0.3 * (h - 0.5), 0.0, 1.0) * 0.55;
  vec3 col = mix(u_color, u_cool, cool * (1.0 - u_hue));
  // The nearer half keeps the colour; beyond mid-depth it goes rose, then dusk: two short blends,
  // because gold and violet are near-complementary and a direct blend passes through grey.
  float t = clamp((far - 0.3) / 0.6, 0.0, 1.0);
  vec3 graded = t < 0.5 ? mix(u_color, u_rose, t * 2.0) : mix(u_rose, u_dusk, t * 2.0 - 1.0);
  col = mix(col, graded, u_hue);
  // Banking glint: only a mote that is moving has a heading.
  float moving = smoothstep(0.3, 1.5, len);
  float facing = dot(dir, u_sun);
  float glint = smoothstep(0.35, 1.0, facing) * moving;
  float shade = 1.0 + u_shimmer * moving * (0.9 * glint - 0.35 * smoothstep(0.0, -1.0, facing));
  col = mix(col, u_glint, u_hue * 0.45 * glint);
  // Atmosphere: far motes fade into the dark.
  float atmosphere = mix(0.4 + 0.8 * z, 0.28 + 0.95 * z, u_depth);
  v_col = col * a_mote.w * atmosphere * shade * energy * u_gain;
  // Music shimmer: a slow band of light drifting through the flock, each mote slightly out of step.
  float wave = sin(a_mote.x * 7.0 + a_mote.y * 3.0 - u_phase + h * 2.5);
  v_col *= 1.0 + u_musicShimmer * wave;
  // The crest of the band is a touch whiter (non-negative: additive light must never subtract).
  v_col = mix(v_col, vec3(max(v_col.r, max(v_col.g, v_col.b))), 0.3 * u_musicShimmer * max(wave, 0.0));
}`;

export const MOTE_FS = `${GLSL_HEADER}
in vec3 v_col;
in vec2 v_local;
in float v_len, v_r, v_soft;
out vec4 o;
void main() {
  float t = clamp(v_local.x, 0.0, v_len);
  vec2 q = vec2(v_local.x - t, v_local.y) / v_r;
  float r2 = dot(q, q);
  if (r2 >= 1.0) discard;
  // Brighter at the head than the tail of the frame's streak.
  float head = v_len > 0.0 ? mix(0.5, 1.0, t / v_len) : 1.0;
  // A crisp point near, a soft disc far (normalised so both carry the same light).
  float k = mix(3.2, 1.2, clamp(v_soft, 0.0, 1.0));
  float norm = mix(1.0, 0.55, clamp(v_soft, 0.0, 1.0));
  o = vec4(v_col * exp(-k * r2) * (1.0 - r2) * head * norm, 1.0);
}`;

/** Trail persistence: the previous frame decays (and a tiny floor stops 8-bit residue sticking). */
export const DECAY_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_prev;
uniform float u_decay, u_floor;
void main() { o = max(texture(u_prev, v_uv) * u_decay - u_floor, vec4(0.0)); }`;

/** Glow source: a 4-tap box of the accumulation at quarter resolution. */
export const DOWNSAMPLE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_texel;
void main() {
  vec3 c = texture(u_src, v_uv + u_texel * vec2(-1.0, -1.0)).rgb + texture(u_src, v_uv + u_texel * vec2(1.0, -1.0)).rgb
         + texture(u_src, v_uv + u_texel * vec2(-1.0, 1.0)).rgb + texture(u_src, v_uv + u_texel * vec2(1.0, 1.0)).rgb;
  o = vec4(c * 0.25, 1.0);
}`;

/** Separable Gaussian-ish blur, one direction per pass. */
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
 * Composite: exposure, glow, tone map, ghost frame (active area and the weak top band fade to black).
 * The shared tone map compresses each channel on its own, so dense light washes to white. With
 * `u_hue` it blends toward a tone map of the luminance that keeps the colour's hue and saturation,
 * only letting the very brightest cores go white.
 */
export const COMPOSITE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_accum, u_glow;
uniform float u_exposure, u_glowAmount, u_hue;
${ghostFrameGlsl()}
vec3 hueTone(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 t = c * ((1.0 - exp(-l)) / max(l, 1e-5));
  float over = max(max(t.r, t.g), t.b);
  t = over > 1.0 ? mix(t / over, vec3(1.0), clamp(over - 1.0, 0.0, 1.0)) : t;
  return pow(max(t, vec3(0.0)), vec3(1.0 / 2.2));
}
void main() {
  vec3 c = (texture(u_accum, v_uv).rgb + texture(u_glow, v_uv).rgb * u_glowAmount) * u_exposure;
  o = vec4(mix(ghostTone(c), hueTone(c), u_hue * 0.75) * ghostMask(v_uv), 1.0);
}`;
