/**
 * WebGL2 setup and capability probing. Simulations get a `SimContext`; this
 * module owns the raw context, resizing, and context-loss recovery signals.
 */
import type { GlCapabilities, Quality } from '../core/types';
import { renderSize } from './resolution';

export interface GlSetup { gl: WebGL2RenderingContext; capabilities: GlCapabilities }

export function createGl(canvas: HTMLCanvasElement): GlSetup {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available. Use a current Chrome, Safari 15+, or Firefox.');
  // Test hook: `?forceRgba8=1` leaves the float render-target extensions unrequested so the RGBA8
  // fallback paths of the simulations can be exercised on a GPU that supports float targets.
  const forceRgba8 = typeof location !== 'undefined' && new URLSearchParams(location.search).get('forceRgba8') === '1';
  const floatColor = !forceRgba8 && !!gl.getExtension('EXT_color_buffer_float');
  const halfFloatColor = !forceRgba8 && (floatColor || !!gl.getExtension('EXT_color_buffer_half_float'));
  const linearFloat = !forceRgba8 && !!gl.getExtension('OES_texture_float_linear');
  if (!forceRgba8) gl.getExtension('OES_texture_half_float_linear');
  return { gl, capabilities: { floatColor, halfFloatColor, linearFloat, maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number } };
}

/** Resize within both the requested DPR and the quality tier's pixel budget. */
export function fitCanvas(canvas: HTMLCanvasElement, maxDpr: number, quality: Quality = 'medium'): boolean {
  // Switching mixer tabs hides the element. Keep the world dimensions while audio continues.
  if (!canvas.clientWidth || !canvas.clientHeight) return false;
  const { width, height } = renderSize(canvas.clientWidth, canvas.clientHeight, maxDpr, window.devicePixelRatio, quality);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width; canvas.height = height;
  return true;
}

export function describeGpu(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  return renderer;
}
