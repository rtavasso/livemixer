/**
 * Veil shaders. Everything is composed in linear light inside a float scene
 * target, then a final pass applies exposure, a soft shoulder, gamma and a
 * dither (the scene is dark; 8-bit banding in the background gradient would
 * otherwise show).
 *
 * Space: uniform units (canvas height = 1, x in [0, aspect], y up, z toward
 * the viewer). The camera sits at z = 1 / u_k on the canvas centre axis, so a
 * point at depth z is scaled by 1 / (1 − u_k·z): nearer = larger.
 */
import { GLSL_HEADER } from '../../gl/program';

/** Background: a deep, slightly cool ground with a faint vertical gradient and the dim window behind the curtain. */
export const BACKGROUND_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform float u_aspect;
uniform vec3 u_tint;
uniform float u_backlight;
uniform vec4 u_window;   // centre x, centre y, half width, half height (uniform units)
void main() {
  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y);
  // Floor a touch lighter than the ceiling so the hem and the side edges read against it.
  vec3 ground = mix(vec3(0.0048, 0.0050, 0.0072), vec3(0.0016, 0.0017, 0.0028), smoothstep(0.0, 1.0, v_uv.y));
  // The window: a soft rectangle of the backlight colour, with a wider halo.
  vec2 d = abs(p - u_window.xy) - u_window.zw;
  float box = (1.0 - smoothstep(0.0, 0.16, d.x)) * (1.0 - smoothstep(0.0, 0.16, d.y));
  float halo = exp(-dot(d / (u_window.zw + 0.5), d / (u_window.zw + 0.5)) * 1.5);
  vec3 window = mix(u_tint, vec3(1.0), 0.3) * u_backlight * (0.075 * box + 0.022 * halo);
  // Gentle vignette.
  vec2 q = v_uv - 0.5;
  float vignette = 1.0 - 0.35 * dot(q, q) * 2.0;
  o = vec4((ground + window) * vignette, 1.0);
}`;

export const CLOTH_VS = `${GLSL_HEADER}
in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
uniform float u_aspect;
uniform float u_k;
out vec3 v_pos;
out vec3 v_normal;
out vec2 v_uv;
void main() {
  v_pos = a_position; v_normal = a_normal; v_uv = a_uv;
  float s = 1.0 / max(0.3, 1.0 - u_k * a_position.z);
  vec2 c = vec2(u_aspect * 0.5, 0.5);
  vec2 q = (a_position.xy - c) * s + c;
  gl_Position = vec4(q.x / u_aspect * 2.0 - 1.0, q.y * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Sheer fabric. Coverage follows optical thickness: a base density (from the
 * opacity param, modulated by a fine weave and a coarse unevenness) divided by
 * the cosine of the viewing angle, so folds seen edge-on become nearly opaque
 * while flat areas stay gauzy. Light: transmitted backlight (warm, from the
 * window behind), a faint cool fill from the room, and a soft rim. Output is
 * premultiplied: rgb = fabric radiance × coverage (+ rim), a = coverage.
 */
export const CLOTH_FS = `${GLSL_HEADER}
in vec3 v_pos; in vec3 v_normal; in vec2 v_uv; out vec4 o;
uniform float u_aspect;
uniform float u_opacity;
uniform float u_backlight;
uniform float u_weave;
uniform vec3 u_tint;
uniform vec3 u_cam;
uniform vec3 u_light;
uniform vec2 u_threads;   // stripe counts across u and v
uniform vec2 u_fade;      // uv-space soft edge widths (side, hem)

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec3 n = normalize(v_normal);
  vec3 V = normalize(u_cam - v_pos);
  float facing = abs(dot(n, V));

  // Density: base optical thickness from the opacity param, a resolution-aware weave and a coarse unevenness.
  float tau = -log(1.0 - clamp(u_opacity, 0.0, 0.96));
  vec2 periodsPerPixel = fwidth(v_uv) * u_threads;
  vec2 keep = 1.0 - smoothstep(0.15, 0.4, periodsPerPixel);
  vec2 stripes = 0.5 + 0.5 * cos(v_uv * u_threads * 6.2831853);
  // Warp-dominant striations; the weft is faint so the two never multiply into a dot grid.
  float weave = 1.0 + u_weave * (0.3 * (stripes.x - 0.5) * keep.x + 0.1 * (stripes.y - 0.5) * keep.y);
  float uneven = 1.0 + 0.15 * (vnoise(v_uv * vec2(11.0, 7.0)) - 0.5) + 0.06 * (vnoise(v_uv * vec2(37.0, 23.0)) - 0.5);
  float density = tau * weave * uneven;
  float cover = 1.0 - exp(-density / max(facing, 0.07));
  // Soft selvedge and hem so the cut edges do not read as a hard polygon.
  float edge = smoothstep(0.0, u_fade.x, v_uv.x) * smoothstep(0.0, u_fade.x, 1.0 - v_uv.x) * smoothstep(0.0, u_fade.y, 1.0 - v_uv.y);
  cover *= edge;

  // Transmitted backlight: warm light from the window behind, forward-scattered by the fibres. The scatter
  // lobe brightens toward grazing angles (on top of the coverage rise), which is what makes folds luminous.
  vec3 toLight = u_light - v_pos;
  float dist2 = dot(toLight, toLight);
  vec3 L = toLight * inversesqrt(dist2);
  float through = 0.45 + 0.55 * abs(dot(n, L));
  float falloff = 1.6 / (1.0 + dist2 * 0.55);
  float grazing = 1.0 - facing;
  float lobe = 1.0 + 2.5 * grazing * grazing;
  vec3 glow = u_tint * u_backlight * through * falloff * lobe * 0.22;
  // Faint cool fill from the room side, on whichever face looks at the viewer.
  vec3 nv = dot(n, V) < 0.0 ? -n : n;
  vec3 Lf = normalize(vec3(-0.35, 0.55, 1.0));
  vec3 fill = vec3(0.55, 0.65, 0.85) * (0.005 + 0.02 * max(0.0, dot(nv, Lf)));
  vec3 fabric = (glow + fill) * cover;
  // Soft rim where the sheet turns away from the viewer.
  float rim = grazing * grazing * grazing * grazing * edge;
  fabric += u_tint * u_backlight * rim * 0.08;
  o = vec4(fabric, cover);
}`;

/** Exposure, soft shoulder, gamma and a static dither. */
export const POST_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene;
uniform float u_exposure;
void main() {
  vec3 c = texture(u_scene, v_uv).rgb * u_exposure;
  c = c / (1.0 + c);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  o = vec4(c + d / 255.0, 1.0);
}`;
