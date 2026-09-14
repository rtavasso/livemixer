/** Basin uses local coordinates with z up and the water at z=0. The physical
 * input/flow plane remains x/depth; only the camera changes its projection.
 */
export const DEFAULT_ELEVATION = 40;
export const CAMERA_DISTANCE = 2.4;
export const CAMERA_FOCAL = 2.2;

export const BASIN_VIEW_GLSL = `
uniform vec2 u_viewAngle; // sin/cos elevation above the table
void basinCamera(vec2 screen, out vec3 eye, out vec3 ray) {
  vec3 forward = vec3(0, u_viewAngle.y, -u_viewAngle.x);
  vec3 up = vec3(0, u_viewAngle.x, u_viewAngle.y);
  eye = -forward * ${CAMERA_DISTANCE} + vec3(0, 0, -0.035);
  ray = normalize(forward * ${CAMERA_FOCAL} + vec3(screen.x, 0, 0) + up * screen.y);
}
vec2 ellipsoidRoots(vec3 eye, vec3 ray, vec3 centre, vec3 radii) {
  vec3 o = (eye - centre) / radii, d = ray / radii;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
  float discriminant = b * b - a * c;
  if (discriminant < 0.0) return vec2(1e5);
  float root = sqrt(discriminant);
  return vec2(-b - root, -b + root) / a;
}
vec3 ellipsoidNormal(vec3 p, vec3 centre, vec3 radii) {
  return normalize((p - centre) / (radii * radii));
}
// Exact torus distance for the rolled ceramic lip, marched only inside its
// very thin bounding slab. Most pixels leave the slab in one step.
float rimDistance(vec3 p, float radius, float tube, float height) {
  return length(vec2(length(p.xy) - radius, p.z - height)) - tube;
}
float rimHit(vec3 eye, vec3 ray, float radius, float tube, float height, float epsilon) {
  vec3 extent = vec3(radius + tube, radius + tube, tube);
  vec3 centre = vec3(0, 0, height);
  vec3 safeRay = mix(vec3(1e-6), ray, step(vec3(1e-6), abs(ray)));
  vec3 a = (centre - extent - eye) / safeRay, b = (centre + extent - eye) / safeRay;
  vec3 lo = min(a, b), hi = max(a, b);
  float t = max(max(lo.x, lo.y), max(lo.z, 0.0));
  float end = min(min(hi.x, hi.y), hi.z);
  for (int i = 0; i < 20; i++) {
    if (t > end) break;
    float d = rimDistance(eye + ray * t, radius, tube, height);
    if (d < epsilon) return t;
    t += d;
  }
  return 1e5;
}
vec3 rimNormal(vec3 p, float radius, float height) {
  vec3 axis = vec3(normalize(p.xy) * radius, height);
  return normalize(p - axis);
}
`;
