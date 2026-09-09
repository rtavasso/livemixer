/**
 * Veil shaders. Everything is composed in linear light inside a float scene
 * target, then a final pass applies exposure, a soft shoulder, gamma and a
 * dither (the scene is dark; 8-bit banding in the background gradient would
 * otherwise show).
 *
 * Space: the volume in uniform units (canvas height = 1): x in [0, aspect],
 * y up with the floor at 0, z INTO the scene from the glass at 0 to the back
 * wall at u_depth, seen through the shared window camera (eye on the centre
 * axis, u_eye in front of the glass). The cloth mesh arrives in the solver's
 * frame — z from the sheet's resting plane toward the viewer — and the vertex
 * shader is the one place it becomes world space; the camera, the light and
 * the hands are all world.
 */
import { GLSL_HEADER } from '../../gl/program';
import { MAX_COLLIDERS } from './cloth';

/**
 * The room: the window camera run backwards. Each pixel's ray leaves the eye
 * through its point on the glass and lands on the floor (y = 0) or the back
 * wall (z = depth), which carries the dim window. The floor catches a pool of
 * the window's light by the wall and a soft reflection of the window itself.
 * Hands that are behind the sheet are ray-cast here too, as dark spheres
 * against the wall: seen through the gauze they are the silhouettes a hand
 * makes behind a backlit curtain.
 */
export const BACKGROUND_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform float u_aspect, u_depth, u_eye, u_plane;
uniform vec3 u_tint;
uniform float u_backlight;
uniform vec4 u_window;   // centre x, centre y, half width, half height, on the back wall (uniform units)
uniform int u_handCount;
uniform vec4 u_hands[${MAX_COLLIDERS}];       // world x, y, z, radius
uniform float u_handAlpha[${MAX_COLLIDERS}];  // how far behind the sheet each hand is, 0..1
void main() {
  vec3 E = vec3(u_aspect * 0.5, 0.5, -u_eye);
  vec3 D = vec3(v_uv.x * u_aspect, v_uv.y, 0.0) - E;
  float tWall = (u_depth - E.z) / D.z;
  float tFloor = D.y < -1e-6 ? -E.y / D.y : tWall + 1.0;
  vec3 glow = mix(u_tint, vec3(1.0), 0.3) * u_backlight;
  vec3 c;
  if (tFloor < tWall) {
    // Floor: near black, a little lighter toward the wall.
    vec3 P = E + D * tFloor;
    float far = clamp(P.z / u_depth, 0.0, 1.0);
    vec3 ground = mix(vec3(0.0040, 0.0041, 0.0058), vec3(0.0060, 0.0061, 0.0080), far);
    // Light through the window pooling on the floor by the wall.
    float toWall = (u_depth - P.z) / (u_window.w + 0.3);
    float across = (P.x - u_window.x) / (u_window.z + 0.4);
    float pool = exp(-toWall * toWall * 1.5 - across * across);
    // The window's reflection: where the ray would meet the wall plane below the floor, against the mirrored window.
    vec3 M = E + D * tWall;
    vec2 dm = abs(vec2(M.x - u_window.x, M.y + u_window.y)) - u_window.zw;
    float mirror = (1.0 - smoothstep(0.0, 0.3, dm.x)) * (1.0 - smoothstep(0.0, 0.6, dm.y));
    // In front of the curtain the reflection is seen through the sheet: dimmer.
    mirror *= mix(0.35, 1.0, smoothstep(u_plane - 0.04, u_plane + 0.04, P.z));
    c = ground + glow * (0.045 * pool + 0.014 * mirror);
  } else {
    // Back wall: a deep, slightly cool ground, lighter near the floor, with the soft window and its halo.
    vec3 P = E + D * tWall;
    vec3 ground = mix(vec3(0.0052, 0.0054, 0.0076), vec3(0.0016, 0.0017, 0.0028), smoothstep(-0.2, 1.4, P.y));
    vec2 d = abs(P.xy - u_window.xy) - u_window.zw;
    float box = (1.0 - smoothstep(0.0, 0.2, d.x)) * (1.0 - smoothstep(0.0, 0.2, d.y));
    vec2 q = d / (u_window.zw + 0.7);
    float halo = exp(-dot(q, q) * 1.5);
    // A touch brighter toward the top of the pane, like sky.
    float sky = 0.85 + 0.3 * smoothstep(u_window.y - u_window.w, u_window.y + u_window.w, P.y);
    c = ground + glow * (0.095 * box * sky + 0.028 * halo);
  }
  // Hands behind the sheet: dark, soft-edged spheres with a faint rim from the window behind them.
  float tHit = min(tFloor, tWall);
  float invLen = inversesqrt(dot(D, D));
  vec3 Dn = D * invLen;
  for (int i = 0; i < ${MAX_COLLIDERS}; i++) {
    if (i >= u_handCount) break;
    vec4 hand = u_hands[i];
    vec3 EC = hand.xyz - E;
    float along = dot(EC, Dn);
    if (along <= 0.0 || along * invLen >= tHit) continue;
    float h = sqrt(max(dot(EC, EC) - along * along, 0.0));
    // The gauze diffuses the silhouette more the further behind the sheet the hand is.
    float soft = clamp(0.2 + 0.7 * (hand.z - u_plane), 0.2, 0.6) * hand.w;
    float cover = (1.0 - smoothstep(hand.w - soft, hand.w + soft * 0.5, h)) * u_handAlpha[i];
    float rim = smoothstep(hand.w * 0.5, hand.w, h);
    c = mix(c, vec3(0.0015, 0.0015, 0.0022) + glow * 0.03 * rim, cover * 0.9);
  }
  // Gentle vignette.
  vec2 v = v_uv - 0.5;
  o = vec4(c * (1.0 - 0.7 * dot(v, v)), 1.0);
}`;

/** Cloth frame → volume → clip space through the shared window camera. */
export const CLOTH_VS = `${GLSL_HEADER}
in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
uniform mat4 u_matrix;   // windowCamera(aspect, depth).matrix
uniform float u_plane;   // world z of the sheet's resting plane; the cloth's z runs from it toward the viewer
out vec3 v_pos;
out vec3 v_normal;
out vec2 v_uv;
void main() {
  vec3 world = vec3(a_position.xy, u_plane - a_position.z);
  v_pos = world; v_normal = vec3(a_normal.xy, -a_normal.z); v_uv = a_uv;
  gl_Position = u_matrix * vec4(world, 1.0);
}`;

/**
 * Sheer fabric. Coverage follows optical thickness: a base density (from the
 * opacity param, modulated by a fine weave and a coarse unevenness) divided by
 * the cosine of the viewing angle, so folds seen edge-on become nearly opaque
 * while flat areas stay gauzy. Light: transmitted backlight (warm, from the
 * window on the back wall, with the soft silhouette of any hand that is
 * between the sheet and the window), a faint cool fill from the room, and a
 * soft rim. Output is premultiplied: rgb = fabric radiance × coverage (+ rim),
 * a = coverage.
 */
export const CLOTH_FS = `${GLSL_HEADER}
in vec3 v_pos; in vec3 v_normal; in vec2 v_uv; out vec4 o;
uniform float u_opacity;
uniform float u_backlight;
uniform float u_weave;
uniform vec3 u_tint;
uniform vec3 u_cam;       // the window camera's eye
uniform vec3 u_light;     // the window's light, a little behind the back wall
uniform vec2 u_threads;   // stripe counts across u and v
uniform vec2 u_fade;      // uv-space soft edge widths (side, hem)
uniform int u_handCount;
uniform vec4 u_hands[${MAX_COLLIDERS}];   // world x, y, z, effective radius

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
  float dist = sqrt(dist2);
  vec3 L = toLight / dist;
  // A hand between the sheet and the window throws a soft silhouette onto the fabric; a hand in front of
  // the sheet (t <= 0) throws none. The window is wide, so the penumbra grows with the hand's distance.
  float shadow = 1.0;
  for (int i = 0; i < ${MAX_COLLIDERS}; i++) {
    if (i >= u_handCount) break;
    vec4 hand = u_hands[i];
    vec3 toHand = hand.xyz - v_pos;
    float t = dot(toHand, L);
    if (t <= 0.0 || t >= dist) continue;
    float off = length(toHand - L * t);
    float soft = hand.w * (0.3 + 1.0 * t / dist);
    shadow *= mix(0.55, 1.0, smoothstep(hand.w - 0.5 * soft, hand.w + soft, off));
  }
  float through = 0.45 + 0.55 * abs(dot(n, L));
  float falloff = 1.6 / (1.0 + dist2 * 0.55);
  float grazing = 1.0 - facing;
  float lobe = 1.0 + 2.5 * grazing * grazing;
  vec3 glow = u_tint * u_backlight * through * falloff * lobe * shadow * 0.22;
  // Faint cool fill from the room's front (the viewer's side), on whichever face looks at the viewer.
  vec3 nv = dot(n, V) < 0.0 ? -n : n;
  vec3 Lf = normalize(vec3(-0.35, 0.55, -1.0));
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
