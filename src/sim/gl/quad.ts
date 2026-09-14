/** Fullscreen triangle plus a shared copy program, cached per context. */
import { GLSL_HEADER, Program } from './program';

export const QUAD_VS = `${GLSL_HEADER}
out vec2 v_uv;
void main() {
  // One oversized triangle covers the viewport without a diagonal seam.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o; uniform sampler2D u_source; uniform float u_gain;
void main() { o = texture(u_source, v_uv) * u_gain; }`;

interface QuadCache { vao: WebGLVertexArrayObject; copy: Program }
const caches = new WeakMap<WebGL2RenderingContext, QuadCache>();

function cache(gl: WebGL2RenderingContext): QuadCache {
  let c = caches.get(gl);
  if (!c) {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create a vertex array.');
    c = { vao, copy: new Program(gl, QUAD_VS, COPY_FS, 'copy') };
    caches.set(gl, c);
    // The same context object comes back after a loss, holding dead objects: forget them.
    if (gl.canvas instanceof HTMLCanvasElement) gl.canvas.addEventListener('webglcontextlost', () => caches.delete(gl), { once: true });
  }
  return c;
}

/** Forget cached objects for a context whose GL state was lost; the next use rebuilds them. */
export function invalidateQuadCache(gl: WebGL2RenderingContext) { caches.delete(gl); }

/** Draw a fullscreen triangle with the currently bound program. */
export function drawQuad(gl: WebGL2RenderingContext) {
  gl.bindVertexArray(cache(gl).vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

/** Copy `texture` to the currently bound target, optionally scaled. */
export function blit(gl: WebGL2RenderingContext, texture: WebGLTexture, gain = 1) {
  cache(gl).copy.use().texture('u_source', texture, 0).f1('u_gain', gain);
  drawQuad(gl);
}

/** Create a fullscreen-quad program from a fragment shader body. */
export function quadProgram(gl: WebGL2RenderingContext, fragmentSource: string, name?: string) {
  return new Program(gl, QUAD_VS, fragmentSource, name);
}
