/**
 * Asynchronous readback of a small RGBA8 target: readPixels into a fresh pixel-pack buffer behind
 * a fence, collected once the fence has signalled (a frame or two later), so the CPU never waits on
 * the GPU for signals. A buffer is never rewritten after being fenced: Chrome keeps a shadow copy
 * per fenced READ-usage buffer and warns when one is overwritten before it is consumed.
 */
export class AsyncReadback {
  readonly bytes: Uint8Array;
  private readonly inFlight: { buffer: WebGLBuffer; fence: WebGLSync }[] = []; // oldest first
  constructor(private readonly gl: WebGL2RenderingContext, private readonly width: number, private readonly height: number, private readonly maxInFlight = 3) {
    this.bytes = new Uint8Array(width * height * 4);
  }

  /** Collect finished readbacks into `bytes` (oldest first; the newest wins). True when `bytes` changed. */
  collect(): boolean {
    const gl = this.gl;
    let fresh = false;
    while (this.inFlight.length) {
      const { buffer, fence } = this.inFlight[0];
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;
      this.inFlight.shift();
      if (status !== gl.WAIT_FAILED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.bytes);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        fresh = true;
      }
      gl.deleteSync(fence); gl.deleteBuffer(buffer);
    }
    return fresh;
  }

  get free() { return this.inFlight.length < this.maxInFlight; }

  /** Queue a readback of the currently bound framebuffer. Call only while `free`. */
  request() {
    const gl = this.gl, buffer = gl.createBuffer();
    if (!buffer) return;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (fence) this.inFlight.push({ buffer, fence }); else gl.deleteBuffer(buffer);
    gl.flush();
  }

  dispose() {
    for (const { buffer, fence } of this.inFlight) { this.gl.deleteSync(fence); this.gl.deleteBuffer(buffer); }
    this.inFlight.length = 0;
  }
}
