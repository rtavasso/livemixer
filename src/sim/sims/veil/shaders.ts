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
 *
 * Hands are the packed capsules of `handSdfGlsl` (`u_capsules`, `u_handBounds`):
 * finger bones, palm and forearm when the source knows them, a sphere otherwise;
 * or, with a depth camera, the scan of `surfaceGlsl` (`u_surface`), a shell of
 * `u_scanThick` behind the scanned front, boxed by `u_scanMin`/`u_scanMax` so
 * only rays that cross the box sample it.
 */
import { GLSL_HEADER } from '../../gl/program';
import { MATERIAL_GLSL } from '../../gl/material';
import { handSdfGlsl } from '../../gl/hand';
import { surfaceGlsl } from '../../gl/surface';

/**
 * The scan's box (world units) and thickness, a slab test (the [t0, t1] along `ro + rd t` inside the box; empty
 * when t1 < t0), and sampling that weights filled cells only. The texture's own bilinear filtering blends the
 * depth of a silhouette edge toward the empty cells' far value, a "skirt" that a ray crossing the outline at any
 * depth can hit; weighting by the mask (as `sampleSurface` does on the CPU) removes it.
 */
const SCAN_GLSL = `${surfaceGlsl()}
uniform vec3 u_scanMin, u_scanMax;
uniform float u_scanThick;
vec2 scanBoxSpan(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / (abs(rd) + 1e-9) * sign(rd + 1e-12);
  vec3 a = (u_scanMin - ro) * inv, b = (u_scanMax - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  return vec2(max(lo.x, max(lo.y, lo.z)), min(hi.x, min(hi.y, hi.z)));
}
// Mask-weighted bilinear sample at sim xy: (depth 0..1 of the volume, mask 0..1). Depth is 1 where nothing is filled.
vec2 scanSample(vec2 xy) {
  ivec2 size = textureSize(u_surface, 0);
  vec2 f = xy * vec2(size) - 0.5;
  ivec2 i0 = clamp(ivec2(floor(f)), ivec2(0), size - 1), i1 = min(i0 + 1, size - 1);
  vec2 t = clamp(f - vec2(i0), 0.0, 1.0);
  vec2 s00 = texelFetch(u_surface, i0, 0).rg, s10 = texelFetch(u_surface, ivec2(i1.x, i0.y), 0).rg;
  vec2 s01 = texelFetch(u_surface, ivec2(i0.x, i1.y), 0).rg, s11 = texelFetch(u_surface, i1, 0).rg;
  float w00 = (1.0 - t.x) * (1.0 - t.y) * s00.g, w10 = t.x * (1.0 - t.y) * s10.g, w01 = (1.0 - t.x) * t.y * s01.g, w11 = t.x * t.y * s11.g;
  float ws = w00 + w10 + w01 + w11;
  float z = ws > 0.0 ? (w00 * s00.r + w10 * s10.r + w01 * s01.r + w11 * s11.r) / ws : 1.0;
  return vec2(z, ws);
}
// World-space normal of the scan at sim xy, toward the viewer; one-sided at the silhouette so the edge has no skirt slope.
vec3 scanNormal(vec2 xy) {
  vec2 c = scanSample(xy);
  vec2 r = scanSample(xy + vec2(u_surfaceTexel.x, 0.0)), l = scanSample(xy - vec2(u_surfaceTexel.x, 0.0));
  vec2 u = scanSample(xy + vec2(0.0, u_surfaceTexel.y)), d = scanSample(xy - vec2(0.0, u_surfaceTexel.y));
  float mr = step(0.5, r.y), ml = step(0.5, l.y), mu = step(0.5, u.y), md = step(0.5, d.y);
  float zx = mr + ml > 0.0 ? (mix(c.x, r.x, mr) - mix(c.x, l.x, ml)) / ((mr + ml) * u_surfaceTexel.x * u_surfaceAspect) : 0.0;
  float zy = mu + md > 0.0 ? (mix(c.x, u.x, mu) - mix(c.x, d.x, md)) / ((mu + md) * u_surfaceTexel.y) : 0.0;
  return normalize(vec3(zx * u_surfaceDepth, zy * u_surfaceDepth, -1.0));
}
// March a world ray from ro (z >= 0) until it passes behind the scanned front, stopping at z = zExit. xyz = hit, w = 1; w = 0 for a miss.
vec4 scanHit(vec3 ro, vec3 rd, float zExit, int steps) {
  if (rd.z <= 1e-5) return vec4(0.0);
  float t1 = (zExit - ro.z) / rd.z, dt = t1 / float(steps);
  vec3 prev = ro;
  for (int i = 1; i <= steps; i++) {
    vec3 p = ro + rd * (dt * float(i));
    vec2 s = scanSample(vec2(p.x / u_surfaceAspect, p.y));
    if (s.y > 0.5 && p.z >= s.x * u_surfaceDepth) {
      vec3 a = prev, b = p;
      for (int j = 0; j < 4; j++) { vec3 m = (a + b) * 0.5; vec2 ms = scanSample(vec2(m.x / u_surfaceAspect, m.y)); if (ms.y > 0.5 && m.z >= ms.x * u_surfaceDepth) b = m; else a = m; }
      return vec4(b, 1.0);
    }
    prev = p;
  }
  return vec4(0.0);
}`;

/**
 * The room: the window camera run backwards. Each pixel's ray leaves the eye
 * through its point on the glass and lands on the floor (y = 0) or the back
 * wall (z = depth), which carries the dim window. The floor catches a pool of
 * the window's light by the wall and a soft reflection of the window itself.
 * Hands are ray-marched here too, through their capsule field and only along
 * the part of the ray inside a hand's bounding sphere, as a dark solid against
 * the wall: seen through the gauze it is the silhouette a hand makes behind a
 * backlit curtain. Only what has reached the sheet's depth shows, so fingers
 * poking through appear before the palm, and a hand in front stays unseen.
 * With a depth camera the scan is marched instead, inside its box.
 */
export const BACKGROUND_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
${MATERIAL_GLSL}
uniform float u_aspect, u_depth, u_eye, u_plane;
uniform vec3 u_tint;
uniform float u_backlight;
uniform vec4 u_window;   // centre x, centre y, half width, half height, on the back wall (uniform units)
${handSdfGlsl()}
${SCAN_GLSL}
vec3 handNormal(vec3 p) {
  vec2 e = vec2(0.003, 0.0);
  return normalize(vec3(handDistance(p + e.xyy) - handDistance(p - e.xyy), handDistance(p + e.yxy) - handDistance(p - e.yxy), handDistance(p + e.yyx) - handDistance(p - e.yyx)));
}
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
    vec3 ground = mix(vec3(0.027, 0.023, 0.019), vec3(0.045, 0.038, 0.03), far);
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
    ground *= 0.85 + 0.3 * materialNoise(P.xz * vec2(9.0, 180.0));
    c = ground + glow * (0.11 * pool + 0.05 * mirror);
  } else {
    // Back wall: a deep, slightly cool ground, lighter near the floor, with the soft window and its halo.
    vec3 P = E + D * tWall;
    vec3 ground = mix(vec3(0.065, 0.064, 0.06), vec3(0.028, 0.034, 0.045), smoothstep(-0.2, 1.4, P.y));
    vec2 d = abs(P.xy - u_window.xy) - u_window.zw;
    float box = (1.0 - smoothstep(0.0, 0.055, d.x)) * (1.0 - smoothstep(0.0, 0.055, d.y));
    vec2 pane = abs(P.xy - u_window.xy);
    float frame = smoothstep(0.009, 0.028, pane.x) * smoothstep(0.009, 0.028, pane.y);
    box *= mix(0.28, 1.0, frame);
    vec2 q = d / (u_window.zw + 0.7);
    float halo = exp(-dot(q, q) * 1.5);
    // A touch brighter toward the top of the pane, like sky.
    float sky = 0.85 + 0.3 * smoothstep(u_window.y - u_window.w, u_window.y + u_window.w, P.y);
    c = ground + glow * (0.42 * box * sky + 0.055 * halo);
  }
  // Hands: sphere-trace the capsule field along the part of the ray inside a hand's bounds, stopping at the room.
  // A dark silhouette with a faint rim from the window behind it. What lies in front of the sheet's plane stays
  // unseen (the sheet is drawn over this pass; a finger appears as it reaches the fabric), and the gauze
  // diffuses the edge: a ray that only grazes the hand still picks up some of its shadow, more the deeper it is.
  if (u_capsuleCount > 0) {
    float invLen = inversesqrt(dot(D, D));
    vec3 Dn = D * invLen;
    vec2 span = handBoundsHit(E, Dn);
    float t = max(span.x, 0.0), tEnd = min(span.y, min(tFloor, tWall) / invLen);
    if (tEnd > t) {
      float hit = -1.0, nearest = 1e9, tNear = t;
      for (int i = 0; i < 40; i++) {
        vec3 q = E + Dn * t;
        float d = handDistance(q);
        if (d < nearest) { nearest = d; tNear = t; }
        if (d < 0.0015) { hit = t; break; }
        t += max(d, 0.002);
        if (t > tEnd) break;
      }
      vec3 q = E + Dn * (hit > 0.0 ? hit : tNear);
      float behind = smoothstep(u_plane - 0.12, u_plane - 0.02, q.z);
      float soft = clamp(0.012 + 0.08 * (q.z - u_plane), 0.012, 0.06);
      float cover = 1.0 - smoothstep(0.0, soft, max(nearest, 0.0));
      float rim = 0.0;
      if (hit > 0.0) { vec3 nrm = handNormal(q); rim = pow(1.0 - abs(dot(nrm, Dn)), 3.0); }
      c = mix(c, vec3(0.0015, 0.0015, 0.0022) + glow * 0.03 * rim, cover * behind * 0.9);
    }
  }
  // The scan: march the ray through the shell, only along the part inside the scan's box and in front of the room.
  if (u_surfaceReady == 1) {
    float invLen = inversesqrt(dot(D, D));
    vec3 Dn = D * invLen;
    vec2 span = scanBoxSpan(E, Dn);
    float t0 = max(span.x, 0.0), t1 = min(span.y, min(tFloor, tWall) / invLen);
    if (t1 > t0) {
      vec4 hit = scanHit(E + Dn * t0, Dn, (E + Dn * t1).z, 24);
      if (hit.w > 0.0) {
        vec2 xy = vec2(hit.x / u_surfaceAspect, hit.y);
        vec3 nrm = scanNormal(xy);
        float rim = pow(1.0 - abs(dot(nrm, Dn)), 3.0);
        float behind = smoothstep(u_plane - 0.12, u_plane - 0.02, hit.z);
        // The scan is coarse (a cell is several pixels): soften the silhouette with a small cross of mask taps.
        vec2 e = u_surfaceTexel * 0.75;
        float m = (surfaceMask(xy) * 2.0 + surfaceMask(xy + vec2(e.x, 0.0)) + surfaceMask(xy - vec2(e.x, 0.0)) + surfaceMask(xy + vec2(0.0, e.y)) + surfaceMask(xy - vec2(0.0, e.y))) / 6.0;
        float cover = smoothstep(0.35, 0.9, m);
        c = mix(c, vec3(0.0015, 0.0015, 0.0022) + glow * 0.03 * rim, cover * behind * 0.9);
      }
    }
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
 * between the sheet and the window, sampled through the hand's capsule field
 * along the light ray), a faint cool fill from the room, and a soft rim.
 * Output is premultiplied: rgb = fabric radiance × coverage (+ rim),
 * a = coverage.
 */
export const CLOTH_FS = `${GLSL_HEADER}
in vec3 v_pos; in vec3 v_normal; in vec2 v_uv; out vec4 o;
${MATERIAL_GLSL}
uniform float u_opacity;
uniform float u_backlight;
uniform float u_weave, u_sheen;
uniform vec3 u_fabric;
uniform vec3 u_tint;
uniform vec3 u_cam;       // the window camera's eye
uniform vec3 u_light;     // the window's light, a little behind the back wall
uniform vec2 u_threads;   // stripe counts across u and v
uniform vec2 u_fade;      // uv-space soft edge widths (side, hem)
${handSdfGlsl()}
${SCAN_GLSL}

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
  float weave = 1.0 + u_weave * (0.22 * (stripes.x - 0.5) * keep.x + 0.18 * (stripes.y - 0.5) * keep.y);
  float uneven = 1.0 + 0.15 * (vnoise(v_uv * vec2(11.0, 7.0)) - 0.5) + 0.06 * (vnoise(v_uv * vec2(37.0, 23.0)) - 0.5);
  // Turned hems have three layers, two fine stitch rows, and a slightly puckered edge.
  float hem = smoothstep(0.94, 0.95, v_uv.y);
  float selvedge = 1.0 - smoothstep(0.008, 0.018, min(v_uv.x, 1.0 - v_uv.x));
  float stitch = exp(-pow((v_uv.y - 0.952) / max(fwidth(v_uv.y), 0.0006), 2.0))
               + exp(-pow((v_uv.y - 0.978) / max(fwidth(v_uv.y), 0.0006), 2.0));
  float density = tau * weave * uneven * (1.0 + 1.8 * hem + 1.2 * selvedge);
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
  // A hand between the sheet and the window throws a soft silhouette onto the fabric; a hand in front of the
  // sheet throws none. The capsule field is sampled along the light ray only where it crosses a hand's
  // bounding sphere; the window is wide, so the penumbra grows with the hand's distance from the sheet.
  float shadow = 1.0;
  if (u_capsuleCount > 0) {
    vec2 span = handBoundsHit(v_pos, L);
    float t0 = max(span.x, 0.0), t1 = min(span.y, dist);
    if (t1 > t0) {
      float closest = 1e9;
      for (int i = 0; i < 16; i++) {
        float t = mix(t0, t1, (float(i) + 0.5) / 16.0);
        float soft = 0.04 + 0.16 * t / dist;
        closest = min(closest, handDistance(v_pos + L * t) / soft);
      }
      shadow = mix(0.55, 1.0, smoothstep(-0.5, 1.0, closest));
    }
  }
  // The scan's shadow: the light ray sampled through the shell, only inside the scan's box. The shell test is
  // sharp in z and uses the mask-weighted depth (the texture's own filtering would let the outline's skirt be
  // hit at any depth and smear along the ray); the penumbra comes from the mask's own bilinear edge, widened a
  // little with the hand's distance from the sheet.
  if (u_surfaceReady == 1) {
    vec2 span = scanBoxSpan(v_pos, L);
    float t0 = max(span.x, 0.0), t1 = min(span.y, dist);
    if (t1 > t0) {
      float cover = 0.0;
      for (int i = 0; i < 16; i++) {
        float t = mix(t0, t1, (float(i) + 0.5) / 16.0);
        vec3 q = v_pos + L * t;
        vec2 xy = vec2(q.x / u_surfaceAspect, q.y);
        vec2 s = scanSample(xy);
        float zs = s.x * u_surfaceDepth;
        if (s.y < 0.05 || q.z < zs - 0.01 || q.z > zs + u_scanThick + 0.01) continue;
        float blur = 0.5 + 2.0 * t / dist;
        float m = (s.y + surfaceMask(xy + u_surfaceTexel * vec2(blur, 0.0)) + surfaceMask(xy - u_surfaceTexel * vec2(blur, 0.0)) + surfaceMask(xy + u_surfaceTexel * vec2(0.0, blur)) + surfaceMask(xy - u_surfaceTexel * vec2(0.0, blur))) * 0.2;
        cover = max(cover, m);
      }
      shadow *= mix(1.0, 0.55, cover);
    }
  }
  float through = 0.35 + 0.65 * abs(dot(n, L));
  float falloff = 1.6 / (1.0 + dist2 * 0.55);
  float grazing = 1.0 - facing;
  vec3 nv = dot(n, V) < 0.0 ? -n : n;
  vec3 Lf = normalize(vec3(-0.65, 0.45, -0.8));
  float noL = max(dot(nv, Lf), 0.0);
  // Wrapped diffuse and transmitted daylight. Edge-on fibres absorb more
  // light, while front-lit folds reveal the independent colour of the yarn.
  vec3 diffuse = u_fabric * (vec3(0.10, 0.13, 0.18) + vec3(0.52, 0.48, 0.40) * noL);
  vec3 transmission = sqrt(u_fabric) * u_tint * u_backlight * through * falloff * shadow * 0.28;
  // Charlie fibre distribution (Imageworks / Filament), broad and non-metallic.
  vec3 H = normalize(Lf + V);
  float noH = max(dot(nv, H), 0.0);
  float distribution = 3.0 * pow(max(1.0 - noH * noH, 0.0), 1.25) / 6.2831853;
  float visibility = 1.0 / max(4.0 * (noL + facing - noL * facing), 0.12);
  vec3 sheen = sqrt(u_fabric) * u_sheen * distribution * visibility * noL * 2.0;
  // Fine slubs modulate radiance without aliasing into a screen-space dot grid.
  float fibre = 1.0 + u_weave * 0.07 * (vnoise(v_uv * vec2(320.0, 90.0)) - 0.5);
  vec3 fabric = ((diffuse + transmission) * fibre + sheen) * cover;
  fabric *= 1.0 - 0.10 * clamp(stitch, 0.0, 1.0);
  fabric += sqrt(u_fabric) * u_tint * u_sheen * pow(grazing, 4.0) * edge * 0.035;
  o = vec4(fabric, cover);
}`;

/** Exposure, soft shoulder, gamma and a static dither. */
export const POST_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
${MATERIAL_GLSL}
uniform sampler2D u_scene;
uniform float u_exposure;
void main() {
  vec3 c = texture(u_scene, v_uv).rgb * u_exposure;
  o = vec4(filmicOutput(c, gl_FragCoord.xy), 1.0);
}`;
