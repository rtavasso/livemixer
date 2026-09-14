/** Small analytic studio environment: no external textures or ray-marching.
 * Reflection directions use z up. All radiance is linear until filmicOutput.
 * Roughness broadens the rectangular emitters; this is an art-directed area
 * light approximation, not a prefiltered HDR environment or path tracer.
 */
export const MATERIAL_GLSL = `
float materialHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float materialNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(materialHash(i), materialHash(i + vec2(1, 0)), f.x),
             mix(materialHash(i + vec2(0, 1)), materialHash(i + vec2(1, 1)), f.x), f.y);
}
vec3 studioEnvironment(vec3 r, float roughness) {
  vec2 p = r.xy / max(r.z, 0.15);
  float blur = 0.012 + roughness * 0.7;
  vec2 aa = max(fwidth(p), vec2(0.002)) + blur;
  vec2 window = 1.0 - smoothstep(vec2(0.27, 0.34) - aa, vec2(0.27, 0.34) + aa, abs(p - vec2(-0.30, 0.40)));
  vec2 mullion = smoothstep(vec2(0.012), vec2(0.012) + aa, abs(p - vec2(-0.30, 0.40)));
  float pane = window.x * window.y * mix(0.28, 1.0, mullion.x * mullion.y);
  vec2 strip = 1.0 - smoothstep(vec2(0.065, 0.65), vec2(0.065, 0.65) + aa * 2.0, abs(p - vec2(1.1, -0.25)));
  vec3 room = mix(vec3(0.045, 0.032, 0.025), vec3(0.18, 0.24, 0.32), smoothstep(-0.2, 0.9, r.z));
  return room + smoothstep(0.0, 0.15, r.z) * (vec3(5.4, 5.8, 6.2) * pane + vec3(3.2, 2.1, 1.2) * strip.x * strip.y);
}
vec3 filmicOutput(vec3 linearColor, vec2 pixel) {
  vec3 x = max(linearColor, vec3(0.0));
  vec3 mapped = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(mapped, vec3(1.0 / 2.2)) + (materialHash(pixel) - 0.5) / 255.0;
}
`;
