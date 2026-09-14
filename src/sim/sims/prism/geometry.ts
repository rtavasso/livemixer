/**
 * The prism in the volume: its camera, its corners, its projected silhouette
 * and the shading of its faces. Pure functions over numbers and typed arrays,
 * no WebGL, so the tests can check the geometry directly.
 *
 * Camera. The shared window camera keeps its eye at mid height, which would
 * show the horizontal light plane edge-on: at hand height 0.5 the whole fan
 * collapses to one horizontal line, anywhere else to a sliver. `prismCamera`
 * is the same construction with the eye raised above the volume: the frustum
 * still passes exactly through the front face (a point at z = 0 lands where a
 * 2D drawing would) but deeper points slide up and in, so the floor, the light
 * plane and the top of the glass all read as surfaces seen from a little above.
 */
import { DEFAULT_EYE, type WindowCamera } from '../../core/camera';

/** Height of the eye above the floor in uniform units; above the volume's top so horizontal planes read as planes. */
export const EYE_HEIGHT = 1.1;

/**
 * Window camera with a raised eye at (aspect / 2, eyeY, −eye). Same contract as `windowCamera`: `matrix` for
 * shaders, `project` for CPU placement, `scale(z)` = eye / (eye + z). Column-major, as WebGL wants it.
 */
export function prismCamera(aspect: number, depth: number, eye = DEFAULT_EYE, eyeY = EYE_HEIGHT, near = eye * .1, far = eye + depth + 2): WindowCamera {
  const halfW = aspect / 2, halfH = .5, cx = halfW, cy = halfH;
  const a = (far + near) / (far - near), b = -2 * far * near / (far - near);
  // Glass point of world p seen from the eye: y_g = eyeY + (p.y − eyeY)·eye / (eye + z); as NDC (y_g − ½) / ½.
  // Rows (as maths): clip = [ (x−cx)·E/halfW, (y−cy)·E/halfH + shear·z, a·(z+E)+b, z+E ] with shear = (eyeY − cy) / halfH.
  const shear = (eyeY - cy) / halfH;
  const m = new Float32Array(16);
  m[0] = eye / halfW; m[12] = -cx * eye / halfW;
  m[5] = eye / halfH; m[9] = shear; m[13] = -cy * eye / halfH;
  m[10] = a; m[14] = a * eye + b;
  m[11] = 1; m[15] = eye;
  const scale = (z: number) => eye / (eye + z);
  return {
    aspect, depth, eye, matrix: m, scale,
    project(p) {
      const w = p.z + eye;
      return { x: (p.x - cx) * eye / halfW / w, y: ((p.y - cy) * eye / halfH + shear * p.z) / w, ndcZ: (a * w + b) / w, scale: scale(p.z) };
    },
  };
}

/**
 * The six corners of a standing prism, bottom triangle first (indices 0..2 at y = 0) then the top (3..5 at
 * y = `height`), three floats each. Corner i sits at the same angle as vertex i of the tracer's polygon.
 */
export function prismCorners(cx: number, cz: number, radius: number, rotation: number, height: number, out: Float32Array | Float64Array): void {
  for (let i = 0; i < 3; i++) {
    const angle = rotation + (i / 3) * Math.PI * 2, x = cx + radius * Math.cos(angle), z = cz + radius * Math.sin(angle);
    out[i * 3] = x; out[i * 3 + 1] = 0; out[i * 3 + 2] = z;
    out[9 + i * 3] = x; out[9 + i * 3 + 1] = height; out[9 + i * 3 + 2] = z;
  }
}

const hullOrder = new Int32Array(16), hullStack = new Int32Array(32);

/**
 * Convex hull (counter-clockwise, collinear points dropped) of `count` ≤ 16 points given as x, y pairs. Writes
 * pairs into `out` starting at `offset` and returns the number of hull vertices. Andrew's monotone chain; no
 * allocation, so it can run per frame.
 */
export function convexHull(points: ArrayLike<number>, count: number, out: Float32Array | Float64Array, offset = 0): number {
  const n = Math.min(count, hullOrder.length);
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) hullOrder[i] = i;
  // Insertion sort by x then y: a handful of points.
  for (let i = 1; i < n; i++) {
    const k = hullOrder[i], kx = points[k * 2], ky = points[k * 2 + 1];
    let j = i - 1;
    while (j >= 0) { const o = hullOrder[j], ox = points[o * 2], oy = points[o * 2 + 1]; if (ox < kx || (ox === kx && oy <= ky)) break; hullOrder[j + 1] = o; j--; }
    hullOrder[j + 1] = k;
  }
  const cross = (o: number, a: number, b: number) => (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) - (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);
  let top = 0;
  for (let i = 0; i < n; i++) { const p = hullOrder[i]; while (top >= 2 && cross(hullStack[top - 2], hullStack[top - 1], p) <= 1e-12) top--; hullStack[top++] = p; }
  const lowerEnd = top + 1;
  for (let i = n - 2; i >= 0; i--) { const p = hullOrder[i]; while (top >= lowerEnd && cross(hullStack[top - 2], hullStack[top - 1], p) <= 1e-12) top--; hullStack[top++] = p; }
  const hull = n === 1 ? 1 : top - 1; // the last point repeats the first
  for (let i = 0; i < hull; i++) { const p = hullStack[i]; out[offset + i * 2] = points[p * 2]; out[offset + i * 2 + 1] = points[p * 2 + 1]; }
  return hull;
}

const projected = new Float64Array(12);

/**
 * The prism's outline on the glass: its six corners projected by the camera into glass coordinates (x in
 * 0..aspect, y in 0..1, the frame the composite pass works in) and hulled. Writes pairs into `out` at `offset`
 * and returns the vertex count (3..6).
 */
export function prismSilhouette(camera: WindowCamera, corners: ArrayLike<number>, out: Float32Array | Float64Array, offset = 0): number {
  for (let i = 0; i < 6; i++) {
    const p = camera.project({ x: corners[i * 3], y: corners[i * 3 + 1], z: corners[i * 3 + 2] });
    projected[i * 2] = (p.x * .5 + .5) * camera.aspect; projected[i * 2 + 1] = p.y * .5 + .5;
  }
  return convexHull(projected, 6, out, offset);
}

/** Additive brightness of a glass face from its outward normal and the unit direction to the eye: a base plus a term that grows as the face turns edge-on (Fresnel). */
export function faceBrightness(nx: number, ny: number, nz: number, vx: number, vy: number, vz: number, base: number, glance: number): number {
  const c = Math.abs(nx * vx + ny * vy + nz * vz), g = 1 - Math.min(1, c);
  return base + glance * g * g;
}
