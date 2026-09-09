/** Minimal shader program wrapper with cached uniform locations and readable compile errors. */
export const GLSL_HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';

export class Program {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly attributes = new Map<string, number>();
  constructor(readonly gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string, readonly name = 'program') {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${name}.vert`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${name}.frag`);
    const program = gl.createProgram();
    if (!program) throw new Error('Could not create a WebGL program.');
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const log = gl.getProgramInfoLog(program); gl.deleteProgram(program); throw new Error(`Link error in ${name}: ${log}`); }
    this.handle = program;
  }
  use() { this.gl.useProgram(this.handle); return this; }
  location(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.handle, name));
    return this.uniforms.get(name) ?? null;
  }
  attribute(name: string): number {
    if (!this.attributes.has(name)) this.attributes.set(name, this.gl.getAttribLocation(this.handle, name));
    return this.attributes.get(name)!;
  }
  f1(name: string, x: number) { this.gl.uniform1f(this.location(name), x); return this; }
  f2(name: string, x: number, y: number) { this.gl.uniform2f(this.location(name), x, y); return this; }
  f3(name: string, x: number, y: number, z: number) { this.gl.uniform3f(this.location(name), x, y, z); return this; }
  f4(name: string, x: number, y: number, z: number, w: number) { this.gl.uniform4f(this.location(name), x, y, z, w); return this; }
  i1(name: string, x: number) { this.gl.uniform1i(this.location(name), x); return this; }
  f1v(name: string, values: Float32Array | number[]) { this.gl.uniform1fv(this.location(name), values); return this; }
  f2v(name: string, values: Float32Array | number[]) { this.gl.uniform2fv(this.location(name), values); return this; }
  f3v(name: string, values: Float32Array | number[]) { this.gl.uniform3fv(this.location(name), values); return this; }
  f4v(name: string, values: Float32Array | number[]) { this.gl.uniform4fv(this.location(name), values); return this; }
  matrix4(name: string, values: Float32Array) { this.gl.uniformMatrix4fv(this.location(name), false, values); return this; }
  /** Bind `texture` to unit `unit` and point the sampler uniform at it. */
  texture(name: string, texture: WebGLTexture | null, unit: number) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit); this.gl.bindTexture(this.gl.TEXTURE_2D, texture); this.gl.uniform1i(this.location(name), unit); return this;
  }
  dispose() { this.gl.deleteProgram(this.handle); }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create a shader.');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
    gl.deleteShader(shader);
    const numbered = source.split('\n').map((line, i) => `${String(i + 1).padStart(4)}: ${line}`).join('\n');
    throw new Error(`Shader compile error in ${label}:\n${log}\n${numbered}`);
  }
  return shader;
}
