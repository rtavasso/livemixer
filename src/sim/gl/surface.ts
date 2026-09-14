/**
 * Helpers for the scanned foreground surface (`SimInput.surface`): the 3D scan
 * of whatever a depth camera sees inside the box, as a height field of depth
 * over the front face of the volume.
 *
 *  - `SurfaceTexture` uploads the field as an RGBA8 texture (R = depth z as
 *    0..1 of the volume, G = mask) so shaders can sample it with bilinear
 *    filtering; `surfaceGlsl` gives `surfaceDepth(xy)` / `surfaceMask(xy)`,
 *    `surfaceNormal(xy)` in world units and a `surfaceHit(ro, rd)` ray-march
 *    for rendering the scan with the window camera.
 *  - `sampleSurface`, `surfaceNormalAt`, and `surfaceDepthAt` do the same on
 *    the CPU for cloth, particles and fluids.
 *
 * "Inside" the scan means: at that (x, y), deeper than the scanned front
 * surface, up to a thickness the simulation chooses. A hand is only ever seen
 * from the front, so the scan is a shell, not a closed volume.
 */
import type { SurfaceField, Vec3 } from '../core/types';
import { createTexture, updateTexture } from './fbo';

export class SurfaceTexture {
  texture: WebGLTexture | null = null;
  width = 0; height = 0;
  private pixels = new Uint8Array(0);
  constructor(readonly gl: WebGL2RenderingContext) {}
  /** Upload a field (any size; the texture is re-created when the size changes). Returns true when a texture is bound. */
  upload(field: SurfaceField | null): boolean {
    if (!field) return false;
    const gl = this.gl;
    if (field.width !== this.width || field.height !== this.height || !this.texture) {
      if (this.texture) gl.deleteTexture(this.texture);
      this.width = field.width; this.height = field.height;
      this.pixels = new Uint8Array(field.width * field.height * 4);
      this.texture = createTexture(gl, { width: field.width, height: field.height, format: 'rgba8', filter: 'linear', wrap: 'clamp' });
    }
    const p = this.pixels;
    for (let i = 0, n = field.width * field.height; i < n; i++) {
      p[i * 4] = Math.round(Math.min(1, Math.max(0, field.z[i])) * 255); p[i * 4 + 1] = field.mask[i]; p[i * 4 + 2] = 0; p[i * 4 + 3] = 255;
    }
    updateTexture(gl, this.texture!, { width: field.width, height: field.height, format: 'rgba8', data: p });
    return true;
  }
  dispose() { if (this.texture) this.gl.deleteTexture(this.texture); this.texture = null; }
}

/** GLSL (ES 3.00) for a bound surface texture. Declare nothing else; call with sim-space xy (0..1) or a world ray. */
export function surfaceGlsl(): string {
  return `
uniform sampler2D u_surface;
uniform vec2 u_surfaceTexel;     // 1 / (width, height)
uniform int u_surfaceReady;      // 0 when no scan is available
uniform float u_surfaceAspect, u_surfaceDepth;
float surfaceMask(vec2 xy) { return texture(u_surface, xy).g; }
float surfaceDepth(vec2 xy) { return texture(u_surface, xy).r; }
// World-space normal of the scan at sim xy (points toward the viewer for a surface facing the glass).
vec3 surfaceNormal(vec2 xy) {
  float zx = (surfaceDepth(xy + vec2(u_surfaceTexel.x, 0.0)) - surfaceDepth(xy - vec2(u_surfaceTexel.x, 0.0))) * u_surfaceDepth / (2.0 * u_surfaceTexel.x * u_surfaceAspect);
  float zy = (surfaceDepth(xy + vec2(0.0, u_surfaceTexel.y)) - surfaceDepth(xy - vec2(0.0, u_surfaceTexel.y))) * u_surfaceDepth / (2.0 * u_surfaceTexel.y);
  return normalize(vec3(zx, zy, -1.0));
}
// March a world ray (uniform units) through the volume until it passes behind the scanned surface.
// Returns the world hit point in xyz and 1.0 in w, or w = 0.0 for a miss. 'steps' bounds the cost.
vec4 surfaceHit(vec3 ro, vec3 rd, float depth, int steps) {
  if (u_surfaceReady == 0 || rd.z <= 1e-5) return vec4(0.0);
  float t0 = max(0.0, -ro.z / rd.z), t1 = (depth - ro.z) / rd.z;
  float dt = (t1 - t0) / float(steps);
  vec3 prev = ro + rd * t0;
  for (int i = 1; i <= steps; i++) {
    vec3 p = ro + rd * (t0 + dt * float(i));
    vec2 xy = vec2(p.x / u_surfaceAspect, p.y);
    if (xy.x < 0.0 || xy.x > 1.0 || xy.y < 0.0 || xy.y > 1.0) { prev = p; continue; }
    vec2 s = texture(u_surface, xy).rg;
    if (s.g > 0.5 && p.z >= s.r * depth) {
      // Refine between prev and p.
      vec3 a = prev, b = p;
      for (int j = 0; j < 4; j++) { vec3 m = (a + b) * 0.5; vec2 ms = texture(u_surface, vec2(m.x / u_surfaceAspect, m.y)).rg; if (ms.g > 0.5 && m.z >= ms.r * depth) b = m; else a = m; }
      return vec4(b, 1.0);
    }
    prev = p;
  }
  return vec4(0.0);
}`;
}

/** Bilinear sample of the field at sim (x, y): depth z (sim units) and mask 0..1. Empty cells do not pull the depth. */
export function sampleSurface(field: SurfaceField, x: number, y: number): { z: number; mask: number } {
  const fx = x * field.width - .5, fy = y * field.height - .5;
  const x0 = Math.max(0, Math.min(field.width - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(field.height - 1, Math.floor(fy)));
  const x1 = Math.min(field.width - 1, x0 + 1), y1 = Math.min(field.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  let z = 0, wsum = 0, mask = 0;
  for (const [xi, yi, w] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]] as const) {
    const i = yi * field.width + xi, m = field.mask[i] / 255;
    mask += w * m;
    if (m > 0) { z += w * m * field.z[i]; wsum += w * m; }
  }
  return { z: wsum > 0 ? z / wsum : 1, mask };
}

/** Depth of the scan at sim (x, y), or null where nothing was scanned. */
export function surfaceDepthAt(field: SurfaceField, x: number, y: number): number | null {
  const s = sampleSurface(field, x, y);
  return s.mask > .5 ? s.z : null;
}

/** World-space normal (uniform units) of the scan at sim (x, y); points toward the glass. */
export function surfaceNormalAt(field: SurfaceField, x: number, y: number, aspect: number, depth: number): Vec3 {
  const ex = 1 / field.width, ey = 1 / field.height;
  const zx = (sampleSurface(field, x + ex, y).z - sampleSurface(field, x - ex, y).z) * depth / (2 * ex * aspect);
  const zy = (sampleSurface(field, x, y + ey).z - sampleSurface(field, x, y - ey).z) * depth / (2 * ey);
  const l = Math.sqrt(zx * zx + zy * zy + 1) || 1;
  return { x: zx / l, y: zy / l, z: -1 / l };
}

/** True when sim point p lies within `thickness` (sim z units) behind the scanned surface. */
export function surfaceContains(field: SurfaceField, p: Vec3, thickness: number): boolean {
  const z = surfaceDepthAt(field, p.x, p.y);
  return z !== null && p.z >= z && p.z <= z + thickness;
}
