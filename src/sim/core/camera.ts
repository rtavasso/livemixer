/**
 * The volume and the window camera.
 *
 * Sim space is a box: x, y, z each in [0, 1]. In uniform units (canvas height
 * = 1) the same box is `[0, aspect] × [0, 1] × [0, depth]`, with z growing
 * INTO the scene, away from the viewer. The display is the front face of that
 * box: a window into the volume. The window camera sits `eye` units in front
 * of the glass, centred, looking in, and its frustum passes exactly through
 * the front face, so anything at z = 0 lands where a 2D drawing would, and
 * anything deeper shrinks toward the centre by `eye / (eye + z)`.
 *
 * Matrices are column-major Float32Arrays for WebGL. All functions are pure.
 */
import type { Vec3 } from './types';

export type Mat4 = Float32Array;

/** Default eye distance in uniform units: at the back of a depth-1 volume things appear ~56 % of their front-face size. */
export const DEFAULT_EYE = 1.25;

export interface WindowCamera {
  aspect: number;
  depth: number;
  eye: number;
  /** World (uniform units) → clip space. */
  matrix: Mat4;
  /** World point → normalised device coordinates plus its perspective scale. */
  project(p: Vec3): { x: number; y: number; ndcZ: number; scale: number };
  /** Perspective scale at a depth: 1 at the glass, eye / (eye + z) deeper in. */
  scale(z: number): number;
}

/**
 * Build the window camera. `near`/`far` bound the depth buffer only; the
 * defaults cover a little in front of the glass and well past the back wall.
 *
 * `eyeY` raises or lowers the eye (default 0.5 = the centre of the glass).
 * The frustum still passes exactly through the front face, so z = 0 is
 * unchanged; deeper points then slide toward the eye's height instead of the
 * centre, which lets a horizontal plane (a floor, a sheet of light) be seen
 * from slightly above rather than edge-on.
 */
export function windowCamera(aspect: number, depth: number, eye = DEFAULT_EYE, near = eye * .1, far = eye + depth + 2, eyeY = .5): WindowCamera {
  const halfW = aspect / 2, halfH = .5, cx = halfW, cy = halfH;
  const a = (far + near) / (far - near), b = -2 * far * near / (far - near);
  // Rows (as maths): clip = [ (x-cx)·E/halfW, (y-cy)·E/halfH + (eyeY-cy)/halfH·(z+E) - (eyeY-cy)/halfH·E, a·(z+E)+b, z+E ]
  // The y row keeps the front face fixed and shears deeper points toward the eye's height.
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

/** Sim-space [0,1]³ → uniform-unit world coordinates. */
export const toWorld = (p: Vec3, aspect: number, depth: number): Vec3 => ({ x: p.x * aspect, y: p.y, z: p.z * depth });
/** Uniform-unit world coordinates → sim space. */
export const fromWorld = (p: Vec3, aspect: number, depth: number): Vec3 => ({ x: p.x / aspect, y: p.y, z: p.z / depth });

/** NDC (−1..1) → pixel coordinates with y up. */
export const ndcToPixels = (ndcX: number, ndcY: number, width: number, height: number) => ({ x: (ndcX * .5 + .5) * width, y: (ndcY * .5 + .5) * height });

// --- small mat4 kit for simulations that build their own cameras ------------

export function mat4Identity(): Mat4 { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

/** Standard OpenGL perspective (camera looks down −z of its own space). */
export function mat4Perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far);
  return m;
}

/** Right-handed look-at view matrix. */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  let zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
  let l = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up.y * zz - up.z * zy, xy = up.z * zx - up.x * zz, xz = up.x * zy - up.y * zx;
  l = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[4] = xy; m[5] = yy; m[6] = zy; m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * eye.x + xy * eye.y + xz * eye.z); m[13] = -(yx * eye.x + yy * eye.y + yz * eye.z); m[14] = -(zx * eye.x + zy * eye.y + zz * eye.z); m[15] = 1;
  return m;
}

/** Apply a mat4 to a point (w = 1); returns clip coordinates. */
export function transformPoint(m: Mat4, p: Vec3): { x: number; y: number; z: number; w: number } {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    w: m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
  };
}
