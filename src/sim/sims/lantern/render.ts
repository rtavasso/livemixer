/**
 * Drawing the Lantern: emissive light only, on true black.
 *
 *  1. Scene (full resolution, additive): the bell as one quad in its own frame, shaded
 *     analytically (fresnel-like rim, the margin ring seen slightly from below, a hollow
 *     cavity, radial canals, four warm gonads and a soft core light), then every tentacle and
 *     oral arm as a glowing ribbon (a triangle strip built on the CPU, soft across its width).
 *  2. Bloom at quarter resolution: one downsample, a separable blur.
 *  3. Composite: scene + bloom, the ghost frame (active area and top band fade), tone map.
 *
 * Works with RGBA16F or the RGBA8 fallback (then the scene is stored scaled down to leave headroom).
 */
import { hexToRgb } from '../../core/params';
import { Fbo, bindScreen, pickFormat, type TextureFormat } from '../../gl/fbo';
import { GLSL_HEADER, Program } from '../../gl/program';
import { drawQuad, quadProgram } from '../../gl/quad';
import type { SimContext } from '../../core/types';
import { areaUniform, ghostFrameGlsl } from '../living';
import type { Chain, Lantern } from './creature';

const BELL_VS = `${GLSL_HEADER}
uniform vec2 u_origin;   // rim centre, uniform units
uniform vec2 u_axis;     // apex direction (unit)
uniform vec2 u_size;     // half-width, height
uniform float u_aspect;
out vec2 v_local;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  float W = u_size.x, H = u_size.y;
  vec2 local = vec2(mix(-1.9 * W, 1.9 * W, corner.x), mix(-1.2 * W, H + 0.9 * W, corner.y));
  vec2 right = vec2(u_axis.y, -u_axis.x);
  vec2 p = u_origin + right * local.x + u_axis * local.y;
  v_local = local;
  gl_Position = vec4(p.x / u_aspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const BELL_FS = `${GLSL_HEADER}
in vec2 v_local; out vec4 o;
uniform vec2 u_size;
uniform vec3 u_rim, u_core;
uniform float u_glow, u_squeeze, u_time, u_stroke, u_encode, u_seed;

float sq(float x) { return x * x; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  float W = u_size.x, H = u_size.y;
  vec2 q = vec2(v_local.x / W, v_local.y / H);
  float ang = atan(q.x, max(q.y, 0.0) + 0.05);
  // Scalloped margin: eight soft lobes that ripple with the pulse.
  float lobes = 1.0 + (0.018 + 0.02 * u_squeeze) * sin(ang * 8.0 + u_time * 0.7) * (1.0 - smoothstep(0.0, 0.3, q.y));
  float ro = length(vec2(q.x, max(q.y, 0.0))) / lobes;
  float lip = smoothstep(-0.1, 0.02, q.y);
  float inside = (1.0 - smoothstep(0.975, 1.0, ro)) * lip;
  float edgeWorld = (ro - 1.0) * W;

  // Shell: a thin translucent skin, brightest where the view grazes it (the silhouette).
  float fresnel = inside * (exp(-max(1.0 - ro, 0.0) * 16.0) + 0.22 * exp(-max(1.0 - ro, 0.0) * 4.0));
  float halo = exp(-sq(max(edgeWorld, 0.0) / (0.35 * W))) * smoothstep(-0.25, 0.1, q.y) * (1.0 - inside) * 0.22;
  float shimmer = 0.75 + 0.5 * vnoise(q * 6.0 + vec2(u_seed, u_time * 0.15));
  float fill = inside * 0.04 * shimmer;

  // The subumbrella cavity: hollow, with a faint inner wall.
  vec2 cq = (q - vec2(0.0, -0.1)) / vec2(0.8, 0.72);
  float rc = length(cq);
  float cavity = (1.0 - smoothstep(0.9, 1.0, rc)) * lip;
  fill *= 1.0 - 0.55 * cavity;
  float wall = exp(-abs(1.0 - rc) * 16.0) * inside * 0.28 * smoothstep(-0.05, 0.25, q.y);

  // The margin seen slightly from below: an ellipse ring, the near half brighter.
  vec2 mq = vec2(q.x / 0.99, q.y / (0.14 + 0.04 * u_squeeze));
  float mr = length(mq);
  float ring = exp(-sq((mr - 1.0) * 9.0)) * (q.y < 0.0 ? 1.0 : 0.45);
  // Marginal lights: small beads around the ring that twinkle.
  float ma = atan(mq.y, mq.x);
  float beads = pow(max(0.0, cos(ma * 8.0)), 30.0) * exp(-sq((mr - 1.0) * 12.0));
  beads *= 0.6 + 0.4 * sin(u_time * 2.1 + ma * 3.0);

  // Radial canals from the stomach to the margin.
  float canal = pow(abs(cos(ang * 4.0)), 60.0) * inside * smoothstep(0.25, 0.5, ro) * (1.0 - smoothstep(0.85, 1.0, ro)) * (1.0 - 0.6 * cavity) * 0.45;

  // Organs: four warm gonads around the stomach, and the soft light within.
  vec2 c0 = vec2(0.0, 0.5 + 0.05 * u_squeeze);
  float gonads = 0.0;
  for (int k = 0; k < 4; k++) {
    float a = 0.785 + 1.5708 * float(k);
    vec2 g = c0 + vec2(cos(a) * 0.3, sin(a) * 0.17);
    vec2 d = (q - g) / vec2(0.13, 0.09);
    float r = length(d);
    gonads += exp(-sq((r - 0.7) * 2.2)) * 0.35 + exp(-r * r * 1.2) * 0.3;
  }
  gonads *= inside;
  float core = exp(-dot((q - c0) / vec2(0.55, 0.45), (q - c0) / vec2(0.55, 0.45)) * 1.6);

  float lit = 1.0 + 0.25 * u_squeeze + 0.5 * u_stroke;
  vec3 rim = u_rim * (fresnel * 0.9 + halo + fill + wall + canal + ring * 0.55) + mix(u_rim, vec3(1.0), 0.5) * beads * 0.8;
  vec3 warm = u_core * (gonads * 0.55 + core * (0.28 + 0.2 * u_stroke)) * (0.8 + 0.4 * u_squeeze);
  vec3 c = (rim + warm) * lit * u_glow * 0.6;
  o = vec4(c * u_encode, 1.0);
}`;

const RIBBON_VS = `${GLSL_HEADER}
in vec2 a_pos;
in vec4 a_data; // across (-1..1), along (0 root .. 1 tip), kind (0 tentacle, 1 arm), depth
uniform float u_aspect;
out vec4 v_data;
void main() {
  v_data = a_data;
  gl_Position = vec4(a_pos.x / u_aspect * 2.0 - 1.0, a_pos.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const RIBBON_FS = `${GLSL_HEADER}
in vec4 v_data; out vec4 o;
uniform vec3 u_rim, u_core;
uniform float u_glow, u_time, u_encode, u_squeeze;
float sq(float x) { return x * x; }
void main() {
  float s = v_data.x, t = v_data.y, depth = v_data.w;
  vec3 c;
  if (v_data.z < 0.5) {
    float core = exp(-s * s * 30.0), halo = exp(-s * s * 3.0) * 0.28;
    float fade = pow(1.0 - t, 1.3);
    // Bioluminescent beads travelling down from the bell after each pulse.
    float bead = pow(0.5 + 0.5 * sin(t * 42.0 - u_time * 2.6 + depth * 17.0), 10.0) * (0.35 + 0.65 * u_squeeze);
    vec3 col = mix(mix(u_rim, u_core, 0.3), u_rim * vec3(0.75, 0.9, 1.25), smoothstep(0.0, 0.5, t));
    c = col * (core * (0.7 + 1.2 * bead) + halo) * fade * depth * 0.75;
  } else {
    // Oral arms: frilled curtains folding along their length.
    float ruffle = sin(t * 17.0 + u_time * 1.1 + depth * 5.0) * 0.45;
    float frill = exp(-sq((s - ruffle) * 2.6)) + 0.5 * exp(-sq((s + 0.8 * ruffle) * 3.0));
    float body = exp(-s * s * 2.2) * 0.25;
    float fade = pow(1.0 - t, 1.5) * smoothstep(0.0, 0.08, t);
    vec3 col = mix(u_core, u_rim, 0.25 + 0.6 * t);
    c = col * (frill * 0.3 + body) * fade;
  }
  o = vec4(c * u_glow * u_encode, 1.0);
}`;

const DOWN_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_source; uniform vec2 u_texel;
void main() {
  vec2 t = u_texel;
  o = 0.25 * (texture(u_source, v_uv + vec2(-t.x, -t.y)) + texture(u_source, v_uv + vec2(t.x, -t.y)) + texture(u_source, v_uv + vec2(-t.x, t.y)) + texture(u_source, v_uv + vec2(t.x, t.y)));
}`;

const BLUR_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_source; uniform vec2 u_step; uniform float u_dither;
void main() {
  vec4 c = texture(u_source, v_uv) * 0.2270270;
  c += (texture(u_source, v_uv + u_step * 1.3846154) + texture(u_source, v_uv - u_step * 1.3846154)) * 0.3162162;
  c += (texture(u_source, v_uv + u_step * 3.2307692) + texture(u_source, v_uv - u_step * 3.2307692)) * 0.0702703;
  // On an RGBA8 target, dither so the wide soft halo does not band.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  // Never on black: black must stay invisible.
  float lit = clamp(max(c.r, max(c.g, c.b)) * 128.0, 0.0, 1.0);
  o = c + vec4(vec3(n * u_dither * lit), 0.0);
}`;

const COMPOSITE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene, u_bloom;
uniform float u_decode, u_bloomGain;
${ghostFrameGlsl()}
void main() {
  vec3 c = (texture(u_scene, v_uv).rgb + texture(u_bloom, v_uv).rgb * u_bloomGain) * u_decode;
  o = vec4(ghostTone(c * ghostMask(v_uv)), 1.0);
}`;

/** Floats per ribbon vertex: pos.xy, across, along, kind, depth. */
const STRIDE = 6;
/** Each chain is drawn at twice its point count (Catmull-Rom midpoints). */
const SUB = 2;

export interface LanternLook { color: string; core: string; glow: number }

export class LanternRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly bell: Program;
  private readonly ribbon: Program;
  private readonly down: Program;
  private readonly blur: Program;
  private readonly composite: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private data = new Float32Array(0);
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private readonly format: TextureFormat;
  private readonly encode: number;
  private readonly dither: number;
  private scene: Fbo | null = null;
  private bloomA: Fbo | null = null;
  private bloomB: Fbo | null = null;

  constructor(private readonly ctx: SimContext) {
    const gl = this.gl = ctx.gl;
    this.bell = new Program(gl, BELL_VS, BELL_FS, 'lantern-bell');
    this.ribbon = new Program(gl, RIBBON_VS, RIBBON_FS, 'lantern-ribbon');
    this.down = quadProgram(gl, DOWN_FS, 'lantern-down');
    this.blur = quadProgram(gl, BLUR_FS, 'lantern-blur');
    this.composite = quadProgram(gl, COMPOSITE_FS, 'lantern-composite');
    this.format = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    this.encode = this.format === 'rgba8' ? .35 : 1;
    this.dither = this.format === 'rgba8' ? 1.5 / 255 : 0;
    const vao = gl.createVertexArray(), empty = gl.createVertexArray(), buffer = gl.createBuffer();
    if (!vao || !empty || !buffer) throw new Error('Could not create Lantern buffers.');
    this.vao = vao; this.emptyVao = empty; this.buffer = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const pos = this.ribbon.attribute('a_pos'), dat = this.ribbon.attribute('a_data');
    gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(dat); gl.vertexAttribPointer(dat, 4, gl.FLOAT, false, STRIDE * 4, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private targets(width: number, height: number) {
    if (this.scene && this.scene.width === width && this.scene.height === height) return;
    this.scene?.dispose(); this.bloomA?.dispose(); this.bloomB?.dispose();
    const bw = Math.max(1, Math.round(width / 4)), bh = Math.max(1, Math.round(height / 4));
    this.scene = new Fbo(this.gl, width, height, this.format);
    this.bloomA = new Fbo(this.gl, bw, bh, this.format);
    this.bloomB = new Fbo(this.gl, bw, bh, this.format);
  }

  /** Build the ribbon strips; returns [first vertex, count] per chain. */
  private buildRibbons(chains: readonly Chain[], size: number): Array<[number, number]> {
    let total = 0;
    for (const c of chains) total += ((c.n - 1) * SUB + 1) * 2;
    if (this.data.length < total * STRIDE) this.data = new Float32Array(total * STRIDE);
    const d = this.data, ranges: Array<[number, number]> = [];
    let v = 0;
    for (const c of chains) {
      const arm = c.kind === 'arm';
      const m = (c.n - 1) * SUB + 1;
      const first = v;
      if (this.sx.length < m) { this.sx = new Float32Array(m); this.sy = new Float32Array(m); }
      const sx = this.sx, sy = this.sy;
      for (let j = 0; j < m; j++) {
        const i = Math.min(c.n - 2, Math.floor(j / SUB));
        catmull(c, i, j / SUB - i);
        sx[j] = P[0]; sy[j] = P[1];
      }
      for (let j = 0; j < m; j++) {
        const x = sx[j], y = sy[j], ja = Math.max(0, j - 1), jb = Math.min(m - 1, j + 1);
        let tx = sx[jb] - sx[ja], ty = sy[jb] - sy[ja];
        const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
        const t = j / (m - 1);
        const w = arm ? size * (.15 + .06 * Math.sin(t * 3.1)) * (1 - .4 * t) : size * (.075 * (1 - .65 * t) + .012) * (.75 + .25 * c.depth);
        for (let side = -1; side <= 1; side += 2) {
          const o = v * STRIDE;
          d[o] = x - ty * w * side; d[o + 1] = y + tx * w * side;
          d[o + 2] = side; d[o + 3] = t; d[o + 4] = arm ? 1 : 0; d[o + 5] = c.depth;
          v++;
        }
      }
      ranges.push([first, v - first]);
    }
    return ranges;
  }

  render(creature: Lantern, width: number, height: number, aspect: number, time: number, look: LanternLook) {
    const gl = this.gl;
    this.targets(width, height);
    const scene = this.scene!, bloomA = this.bloomA!, bloomB = this.bloomB!;
    const [rr, rg, rb] = hexToRgb(look.color), [cr, cg, cb] = hexToRgb(look.core);
    const glow = creature.glow.value * look.glow;

    // 1. Scene, additive.
    scene.clear(0, 0, 0, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.blendEquation(gl.FUNC_ADD);
    const ranges = this.buildRibbons(creature.chains, creature.width / Math.max(.01, 1 - .2 * creature.squeeze));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.ribbon.use().f1('u_aspect', aspect).f3('u_rim', rr, rg, rb).f3('u_core', cr, cg, cb).f1('u_glow', glow).f1('u_time', time)
      .f1('u_encode', this.encode).f1('u_squeeze', creature.squeeze);
    gl.bindVertexArray(this.vao);
    for (const [first, count] of ranges) gl.drawArrays(gl.TRIANGLE_STRIP, first, count);
    const s = Math.sin(creature.heading), c = Math.cos(creature.heading);
    this.bell.use().f2('u_origin', creature.x, creature.y).f2('u_axis', s, c).f2('u_size', creature.width, creature.height).f1('u_aspect', aspect)
      .f3('u_rim', rr, rg, rb).f3('u_core', cr, cg, cb).f1('u_glow', glow).f1('u_squeeze', creature.squeeze).f1('u_time', time)
      .f1('u_stroke', creature.stroke.value).f1('u_encode', this.encode).f1('u_seed', 3.7);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    // 2. Bloom at quarter resolution.
    bloomA.bind();
    this.down.use().texture('u_source', scene.texture, 0).f2('u_texel', 1 / width, 1 / height);
    drawQuad(gl);
    bloomB.bind();
    this.blur.use().texture('u_source', bloomA.texture, 0).f2('u_step', 1.4 / bloomA.width, 0).f1('u_dither', this.dither);
    drawQuad(gl);
    bloomA.bind();
    this.blur.use().texture('u_source', bloomB.texture, 0).f2('u_step', 0, 1.4 / bloomA.height).f1('u_dither', this.dither);
    drawQuad(gl);

    // 3. Composite to the screen.
    bindScreen(gl, width, height);
    const [x0, y0, x1, y1] = areaUniform(this.ctx.activeArea);
    this.composite.use().texture('u_scene', scene.texture, 0).texture('u_bloom', bloomA.texture, 1)
      .f1('u_decode', 1 / this.encode).f1('u_bloomGain', .9).f4('u_area', x0, y0, x1, y1).f1('u_edge', .06);
    drawQuad(gl);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose() {
    const gl = this.gl;
    this.bell.dispose(); this.ribbon.dispose(); this.down.dispose(); this.blur.dispose(); this.composite.dispose();
    gl.deleteVertexArray(this.vao); gl.deleteVertexArray(this.emptyVao); gl.deleteBuffer(this.buffer);
    this.scene?.dispose(); this.bloomA?.dispose(); this.bloomB?.dispose();
  }
}

/** Catmull-Rom point between chain points i and i+1 at fraction f. */
const P = new Float32Array(2);
function catmull(c: Chain, i: number, f: number) {
  const i0 = Math.max(0, i - 1), i1 = i, i2 = Math.min(c.n - 1, i + 1), i3 = Math.min(c.n - 1, i + 2);
  const f2 = f * f, f3 = f2 * f;
  const w0 = -.5 * f3 + f2 - .5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + .5 * f, w3 = .5 * f3 - .5 * f2;
  P[0] = c.x[i0] * w0 + c.x[i1] * w1 + c.x[i2] * w2 + c.x[i3] * w3;
  P[1] = c.y[i0] * w0 + c.y[i1] * w1 + c.y[i2] * w2 + c.y[i3] * w3;
}
