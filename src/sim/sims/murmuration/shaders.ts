/** Murmuration shaders: streaked mote sprites, trail decay, ghost-frame composite. */
import { GLSL_HEADER } from '../../gl/program';
import { ghostFrameGlsl } from '../living';

/**
 * One mote per instance, drawn as a short streak from where it was at the last frame to where it
 * is now (so the trail is continuous at any frame rate): a_mote = (uv x, uv y, depth 0 far … 1
 * near, brightness), a_prev = uv at the previous frame.
 */
export const MOTE_VS = `${GLSL_HEADER}
in vec4 a_mote;
in vec2 a_prev;
uniform vec2 u_px;
uniform float u_size, u_gain, u_maxStreak;
uniform vec3 u_color, u_cool;
out vec3 v_col;
out vec2 v_local;
out float v_len, v_r;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  float z = clamp(a_mote.z, 0.0, 1.0);
  // Parallax: nearer motes are larger and brighter.
  float s = u_size * (0.5 + 0.9 * z);
  float drawn = max(s, 1.5);
  float r = drawn * 0.5;
  vec2 b = a_mote.xy * u_px, a = a_prev * u_px, d = b - a;
  float len = length(d);
  // A jump (reset, count change) draws a dot; a slow frame draws a capped streak ending at the mote.
  if (len > 8.0 * u_maxStreak) { a = b; d = vec2(0.0); len = 0.0; }
  else if (len > u_maxStreak) { a = b - d * (u_maxStreak / len); len = u_maxStreak; }
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
  float along = corner.x < 0.0 ? -r : len + r, across = corner.y * r;
  vec2 p = a + dir * along + nrm * across;
  gl_Position = vec4(p / u_px * 2.0 - 1.0, 0.0, 1.0);
  v_local = vec2(along, across); v_len = len; v_r = r;
  // A sprite clamped up to the minimum size keeps the energy of the smaller one.
  float energy = (s * s) / (drawn * drawn);
  float h = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
  // Faint cool tint on the far motes and a few others.
  float cool = clamp(0.1 + 0.45 * (1.0 - z) + 0.3 * (h - 0.5), 0.0, 1.0) * 0.55;
  v_col = mix(u_color, u_cool, cool) * a_mote.w * (0.4 + 0.8 * z) * energy * u_gain;
}`;

export const MOTE_FS = `${GLSL_HEADER}
in vec3 v_col;
in vec2 v_local;
in float v_len, v_r;
out vec4 o;
void main() {
  float t = clamp(v_local.x, 0.0, v_len);
  vec2 q = vec2(v_local.x - t, v_local.y) / v_r;
  float r2 = dot(q, q);
  if (r2 >= 1.0) discard;
  // Brighter at the head than the tail of the frame's streak.
  float head = v_len > 0.0 ? mix(0.5, 1.0, t / v_len) : 1.0;
  o = vec4(v_col * exp(-3.2 * r2) * (1.0 - r2) * head, 1.0);
}`;

/** Trail persistence: the previous frame decays (and a tiny floor stops 8-bit residue sticking). */
export const DECAY_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_prev;
uniform float u_decay, u_floor;
void main() { o = max(texture(u_prev, v_uv) * u_decay - u_floor, vec4(0.0)); }`;

/** Composite: exposure, tone map, ghost frame (active area and the weak top band fade to black). */
export const COMPOSITE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_accum;
uniform float u_exposure;
${ghostFrameGlsl()}
void main() {
  vec3 c = texture(u_accum, v_uv).rgb;
  o = vec4(ghostTone(c * u_exposure) * ghostMask(v_uv), 1.0);
}`;
