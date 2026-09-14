/** Glazed, wheel-thrown ceramic evaluated on the refracted inner surface.
 * All marks live in bowl coordinates; derivatives fade detail below a pixel.
 * No image textures, extra render targets, or changes to the fluid are required.
 */
export const BASIN_CERAMIC_GLSL = `
uniform float u_ceramicTexture;

// Value and analytic gradient of the same smooth grain, sharing four hashes.
vec3 ceramicGrain(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = materialHash(i), b = materialHash(i + vec2(1, 0));
  float c = materialHash(i + vec2(0, 1)), d = materialHash(i + vec2(1, 1));
  return vec3(mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
    mix(b - a, d - c, u.y) * du.x, mix(c - a, d - b, u.x) * du.y);
}

vec3 basinCeramic(vec3 p, vec3 N, vec3 local, vec3 V, vec3 L, float radius, float scale) {
  vec2 clay = p.xy / scale;
  float strength = u_ceramicTexture;
  float rho = length(local.xy);
  vec2 radial = local.xy / max(rho, 1e-5);
  // Latitude follows the inner wall. Rings foreshorten on its steep sides,
  // providing a shape cue even when the water is completely still.
  float latitude = atan(rho, max(-local.z, 0.0001));
  float mottling = materialNoise(clay * 17.0);
  float phase = latitude * 88.0 + sin(latitude * 19.0 + 1.1) * 0.45 + (mottling - 0.5) * 0.9;
  float ringKeep = (1.0 - smoothstep(1.8, 5.0, fwidth(phase))) * smoothstep(0.025, 0.12, rho);
  float rings = sin(phase) * ringKeep;

  vec2 grainUV = clay * 115.0;
  vec3 grain = ceramicGrain(grainUV);
  float grainKeep = 1.0 - smoothstep(0.35, 0.9, max(fwidth(grainUV).x, fwidth(grainUV).y));
  vec3 tangent = vec3(N.z * radial, -dot(N.xy, radial));
  vec3 grainSlope = vec3(grain.yz, 0);
  grainSlope -= N * dot(grainSlope, N);
  vec3 relief = normalize(N - strength * (tangent * cos(phase) * ringKeep * 0.085 + grainSlope * grainKeep * 0.035));

  // Sparse iron flecks in the fired clay, softened only at their pixel edges.
  vec2 speckUV = clay * 108.0, cell = floor(speckUV);
  float seed = materialHash(cell + 31.7);
  vec2 centre = 0.08 + 0.84 * vec2(materialHash(cell + 7.2), materialHash(cell + 19.8));
  vec2 delta = (fract(speckUV) - centre) * vec2(1.0, 1.3);
  float aa = max(length(fwidth(speckUV)) * 0.55, 0.015);
  float size = 0.075 + 0.09 * seed;
  float specks = (1.0 - smoothstep(size - aa, size + aa, length(delta))) * step(0.85, seed);
  specks *= 1.0 - smoothstep(0.45, 1.0, aa);
  vec3 ceramic = u_glaze * (1.0 + strength * ((mottling - 0.5) * 0.24 + rings * 0.065 + (grain.x - 0.5) * grainKeep * 0.075));
  ceramic *= mix(vec3(1), vec3(0.48, 0.35, 0.22), min(specks * strength * 0.75, 1.0));

  // Direct light must reach this point through the opening. The bowl wall
  // occludes that path instead of painting a radial dark band onto the water.
  vec2 opening = p.xy + L.xy * (max(-p.z, 0.0) / max(L.z, 0.1));
  float visible = 1.0 - smoothstep(radius - 0.022 * scale, radius + 0.008 * scale, length(opening));
  float ambient = 0.22 * (0.6 + 0.4 * max(N.z, 0.0));
  float diffuse = max(dot(relief, L), 0.0) * visible;
  ceramic *= ambient + 0.78 * diffuse;
  // Weak wet-glaze glints follow the ceramic relief, below the water highlight.
  float gloss = pow(max(dot(reflect(-L, relief), V), 0.0), 48.0) * visible;
  return ceramic + vec3(0.025, 0.023, 0.019) * gloss;
}
`;
