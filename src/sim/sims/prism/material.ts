import { GLSL_HEADER } from '../../gl/program';
import { MATERIAL_GLSL } from '../../gl/material';

/** Closed triangular solids, intersected analytically (five planes per prism).
 * Camera rays refract through entry and exit faces; a bounded internal
 * reflection handles TIR. The spectral beam tracer remains the simulation.
 * The studio and stone table are procedural, so this needs no scene copies,
 * screen-space ray march, depth buffer, external assets, or GPU readback.
 */
export const COMPOSITE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene, u_glow, u_wide;
uniform float u_aspect, u_depth, u_eye, u_eyeY, u_glowGain, u_wideGain, u_floor;
uniform vec4 u_planes[6]; // three outward-facing side planes per prism
uniform int u_polys;
uniform float u_height, u_index, u_roughness;
${MATERIAL_GLSL}

vec4 planeAt(int object, int face) {
  if (face == 3) return vec4(0, 1, 0, u_height);
  if (face == 4) return vec4(0, -1, 0, 0);
  return u_planes[object * 3 + face];
}
bool intersectGlass(int object, vec3 origin, vec3 ray, out float enter, out float leave, out vec3 en, out vec3 ex) {
  enter = -1e5; leave = 1e5; en = vec3(0); ex = vec3(0);
  for (int face = 0; face < 5; face++) {
    vec4 p = planeAt(object, face);
    float side = p.w - dot(p.xyz, origin), denom = dot(p.xyz, ray);
    if (abs(denom) < 1e-6) { if (side < 0.0) return false; continue; }
    float t = side / denom;
    if (denom < 0.0 && t > enter) { enter = t; en = p.xyz; }
    if (denom > 0.0 && t < leave) { leave = t; ex = p.xyz; }
  }
  return leave > max(enter, 0.0);
}
vec3 environment(vec3 r) {
  // Tall studio cards to either side of the camera, plus soft overhead daylight.
  vec3 c = studioEnvironment(vec3(r.x, r.y, -r.z), u_roughness);
  float strip = pow(max(0.0, dot(r, normalize(vec3(-0.9, 0.25, -0.2)))), mix(150.0, 12.0, u_roughness));
  float card = exp(-pow((r.x - 0.72) / (0.14 + u_roughness), 2.0)) * smoothstep(-0.3, 0.45, -r.z);
  float horizontal = 0.35 + 0.65 * smoothstep(-0.7, 0.4, r.y);
  return c + vec3(2.3, 2.5, 2.7) * strip + vec3(2.0, 1.85, 1.65) * card * horizontal;
}
float contactShadow(vec3 p) {
  float shade = 1.0;
  for (int q = 0; q < 2; q++) {
    if (q >= u_polys) break;
    float edge = -1e5;
    for (int k = 0; k < 3; k++) { vec4 plane = u_planes[q * 3 + k]; edge = max(edge, dot(plane.xyz, p) - plane.w); }
    shade *= 1.0 - 0.58 * exp(-max(edge, 0.0) * 45.0);
  }
  return shade;
}
vec3 room(vec3 origin, vec3 ray) {
  if (ray.y < -0.0001) {
    float t = max(0.0001, -origin.y / ray.y);
    vec3 p = origin + ray * t;
    if (t > 0.0) {
      float grain = materialNoise(p.xz * 125.0);
      float pool = exp(-dot(p.xz - vec2(u_aspect * 0.5, u_depth * 0.5), p.xz - vec2(u_aspect * 0.5, u_depth * 0.5)) * 1.5);
      vec3 stone = vec3(0.08, 0.085, 0.087) * (0.94 + 0.12 * grain) * (0.25 + pool * 0.75);
      return stone * contactShadow(p) * u_floor;
    }
  }
  return vec3(0.009, 0.013, 0.02) + vec3(0.012, 0.016, 0.025) * max(ray.y, 0.0);
}
float fresnel(float cosTheta) {
  float f0 = pow((u_index - 1.0) / (u_index + 1.0), 2.0);
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}
void main() {
  vec3 eye = vec3(u_aspect * 0.5, u_eyeY, -u_eye);
  vec3 ray = normalize(vec3(v_uv.x * u_aspect, v_uv.y, 0) - eye);
  vec3 base = room(eye, ray);
  float nearest = 1e5; int object = -1; vec3 normal = vec3(0);
  for (int q = 0; q < 2; q++) {
    if (q >= u_polys) break;
    float a, b; vec3 na, nb;
    if (intersectGlass(q, eye, ray, a, b, na, nb) && a > 0.0 && a < nearest) { nearest = a; object = q; normal = na; }
  }
  float beamTransmission = 1.0;
  if (object >= 0) {
    vec3 hit = eye + ray * nearest;
    // A tiny rounded bevel catches broad highlights at real geometric edges.
    vec3 bevel = normal;
    for (int k = 0; k < 5; k++) {
      vec4 p = planeAt(object, k);
      if (dot(p.xyz, normal) > 0.99) continue;
      float edge = p.w - dot(p.xyz, hit);
      bevel += p.xyz * (1.0 - smoothstep(0.0, 0.004, edge)) * 0.65;
    }
    bevel = normalize(bevel);
    float frontF = fresnel(dot(-ray, bevel));
    vec3 reflection = environment(reflect(ray, bevel));
    vec3 internalRay = refract(ray, normal, 1.0 / u_index);
    vec3 internalOrigin = hit + internalRay * 0.0001;
    float a, b; vec3 na, nb;
    vec3 through = base; float thickness = 0.0, exitF = 0.0;
    // At most two internal segments; the loop never grows with material settings.
    for (int bounce = 0; bounce < 2; bounce++) {
      if (!intersectGlass(object, internalOrigin, internalRay, a, b, na, nb)) break;
      thickness += b;
      vec3 exitPoint = internalOrigin + internalRay * b;
      vec3 outsideRay = refract(internalRay, -nb, u_index);
      if (dot(outsideRay, outsideRay) > 0.01) {
        exitF = fresnel(dot(internalRay, nb));
        through = room(exitPoint + outsideRay * 0.001, outsideRay) * (1.0 - exitF)
                + environment(reflect(internalRay, -nb)) * exitF * 0.25;
        break;
      }
      internalRay = reflect(internalRay, nb);
      internalOrigin = exitPoint + internalRay * 0.0001;
      through = environment(internalRay) * 0.4;
    }
    vec3 absorption = exp(-vec3(0.30, 0.075, 0.045) * thickness);
    base = through * absorption * (1.0 - frontF) + reflection * frontF;
    beamTransmission = 0.92 + 0.08 * (1.0 - frontF);
  }
  // Physical spectral paths supply the light, including wall and floor deposits.
  vec3 light = texture(u_scene, v_uv).rgb * beamTransmission
             + texture(u_glow, v_uv).rgb * u_glowGain + texture(u_wide, v_uv).rgb * u_wideGain;
  vec2 v = v_uv - 0.5;
  o = vec4(filmicOutput((base + light) * (1.0 - 0.35 * dot(v, v)), gl_FragCoord.xy), 1.0);
}`;
