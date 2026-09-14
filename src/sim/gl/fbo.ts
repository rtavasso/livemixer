/**
 * Render targets. `pickFormat` chooses the best float-ish format the device
 * can actually render to, falling back to RGBA8 so a simulation still runs
 * (with reduced precision) on a weak GPU.
 */
import type { GlCapabilities } from '../core/types';

export type TextureFormat = 'rgba8' | 'rgba16f' | 'rgba32f' | 'r8';
export interface TextureOptions { width: number; height: number; format: TextureFormat; filter?: 'linear' | 'nearest'; wrap?: 'clamp' | 'repeat'; data?: ArrayBufferView | null }

/** The highest-precision format the device can render to among `preferred`, honouring linear filtering when requested. */
export function pickFormat(caps: GlCapabilities, preferred: TextureFormat[], needLinear = true): TextureFormat {
  for (const f of preferred) {
    if (f === 'rgba32f' && caps.floatColor && (!needLinear || caps.linearFloat)) return f;
    if (f === 'rgba16f' && caps.halfFloatColor) return f; // half float is filterable in WebGL2
    if (f === 'rgba8' || f === 'r8') return f;
  }
  return 'rgba8';
}

function formatTriple(gl: WebGL2RenderingContext, format: TextureFormat): [number, number, number] {
  switch (format) {
    case 'rgba32f': return [gl.RGBA32F, gl.RGBA, gl.FLOAT];
    case 'rgba16f': return [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
    case 'r8': return [gl.R8, gl.RED, gl.UNSIGNED_BYTE];
    default: return [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
  }
}

export function createTexture(gl: WebGL2RenderingContext, options: TextureOptions): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Could not create a texture.');
  const [internal, format, type] = formatTriple(gl, options.format);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, options.width, options.height, 0, format, type, options.data ?? null);
  const filter = options.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  const wrap = options.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/** Upload new pixels into an existing texture of the same size/format. */
export function updateTexture(gl: WebGL2RenderingContext, texture: WebGLTexture, options: TextureOptions) {
  const [, format, type] = formatTriple(gl, options.format);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, options.width, options.height, format, type, options.data ?? null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

export class Fbo {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  constructor(readonly gl: WebGL2RenderingContext, readonly width: number, readonly height: number, readonly format: TextureFormat, filter: 'linear' | 'nearest' = 'linear') {
    this.texture = createTexture(gl, { width, height, format, filter });
    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('Could not create a framebuffer.');
    this.framebuffer = fb;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) { this.dispose(); throw new Error(`Framebuffer incomplete for ${format} ${width}×${height} (status ${status}).`); }
  }
  /** Bind as the render target and set the viewport. */
  bind() { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer); this.gl.viewport(0, 0, this.width, this.height); }
  clear(r = 0, g = 0, b = 0, a = 0) { this.bind(); this.gl.clearColor(r, g, b, a); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }
  dispose() { this.gl.deleteTexture(this.texture); this.gl.deleteFramebuffer(this.framebuffer); }
}

/** Two targets that alternate roles; `read` is the previous state, `write` the next. */
export class PingPong {
  private a: Fbo; private b: Fbo;
  constructor(gl: WebGL2RenderingContext, readonly width: number, readonly height: number, readonly format: TextureFormat, filter: 'linear' | 'nearest' = 'linear') {
    this.a = new Fbo(gl, width, height, format, filter); this.b = new Fbo(gl, width, height, format, filter);
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  clear() { this.a.clear(); this.b.clear(); }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** Bind the default framebuffer with the canvas viewport. */
export function bindScreen(gl: WebGL2RenderingContext, width: number, height: number) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height); }
