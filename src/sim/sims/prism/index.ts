/**
 * Prism — white light and glass.
 *
 * A glass prism floats in darkness. The hand is the light source: a narrow
 * white beam leaves the hand and aims at the prism, so walking around the
 * prism changes the incidence angle and the spectrum fans out, folds,
 * reflects internally and lands as bands of colour. Pushing in widens the
 * beam. With nobody there a faint idle beam orbits on its own.
 *
 * Physics (Snell, Fresnel, Cauchy dispersion, total internal reflection)
 * lives in `optics.ts` as a CPU ray tracer over typed arrays. Rendering
 * uploads the traced segments to a dynamic VBO, expands each into a thin
 * anti-aliased quad with a core and a halo, accumulates additively into a
 * half-float target so overlapping wavelengths add back to white, blurs a
 * quarter-resolution copy twice for glow, and composites with a filmic
 * tone-map. The prism itself is drawn analytically in the composite pass
 * from a signed-distance field, its edges lit by the glow that crosses them.
 *
 * The segment cap (`MAX_SEGMENTS`) is a safety net, not a working limit: an
 * adaptive ray budget lowers the ray count whenever a frame is truncated and
 * creeps it back up afterwards, and the tracer launches rays in an
 * interleaved order across the beam so a truncated frame thins the whole
 * beam evenly instead of dropping one side of it. Tunables that the tests
 * reproduce live in `config.ts`.
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { approach, clamp, clamp01, toUniform } from '../../core/math';
import { bindScreen, Fbo, pickFormat } from '../../gl/fbo';
import { GLSL_HEADER, Program } from '../../gl/program';
import { drawQuad, quadProgram } from '../../gl/quad';
import {
  beamGain, beamWidth, LINE, MAX_POLYGONS, MAX_SEGMENTS, MAX_VERTICES, nextRayBudget, prismCentre, QUALITY, rayCount, TRACE_DEFAULTS, traceOptionsFor,
} from './config';
import {
  buildSpectrum, CAUCHY_B_GLASS, createPolygon, SEGMENT_STRIDE, setRegularPolygon, Tracer,
  type BeamSource, type Polygon, type RawSignals, type Spectrum,
} from './optics';

const TAU = Math.PI * 2;

// Line quads: each segment instance is expanded in the vertex shader. Distances are carried in scene pixels
// so the fragment shader can shape a core and a halo that stay crisp at any resolution.
const LINE_VS = `${GLSL_HEADER}
layout(location = 0) in vec4 a_seg;   // x0 y0 x1 y1 in uniform units
layout(location = 1) in vec4 a_col;   // r g b intensity
uniform vec2 u_scale;                 // uniform units → clip space
uniform float u_pxPerUnit;
uniform float u_halfWidth;            // quad half width in scene pixels
out vec2 v_lin;                       // along, across (scene pixels)
flat out float v_len;
flat out vec4 v_col;
void main() {
  int id = gl_VertexID - (gl_VertexID / 6) * 6;
  float along = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float across = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  vec2 p0 = a_seg.xy, d = a_seg.zw - p0;
  float len = length(d);
  vec2 dir = len > 1e-7 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = u_halfWidth / u_pxPerUnit;
  float t = along * len + (along * 2.0 - 1.0) * hw;
  vec2 p = p0 + dir * t + nrm * (across * hw);
  v_lin = vec2(t * u_pxPerUnit, across * u_halfWidth);
  v_len = len * u_pxPerUnit;
  v_col = a_col;
  gl_Position = vec4(p * u_scale - 1.0, 0.0, 1.0);
}`;

const LINE_FS = `${GLSL_HEADER}
in vec2 v_lin; flat in float v_len; flat in vec4 v_col; out vec4 o;
uniform float u_core, u_halo, u_haloGain;
void main() {
  float dAlong = max(0.0, max(-v_lin.x, v_lin.x - v_len));
  float d2 = dAlong * dAlong + v_lin.y * v_lin.y;
  float core = exp(-d2 / (u_core * u_core));
  float halo = exp(-sqrt(d2) / u_halo) * u_haloGain;
  o = vec4(v_col.rgb * (v_col.a * (core + halo)), 1.0);
}`;

const DOWNSAMPLE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o; uniform sampler2D u_source; uniform vec2 u_texel;
void main() {
  vec3 c = texture(u_source, v_uv + u_texel * vec2(-.25, -.25)).rgb + texture(u_source, v_uv + u_texel * vec2(.25, -.25)).rgb
         + texture(u_source, v_uv + u_texel * vec2(-.25, .25)).rgb + texture(u_source, v_uv + u_texel * vec2(.25, .25)).rgb;
  o = vec4(c * .25, 1.0);
}`;

const BLUR_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o; uniform sampler2D u_source; uniform vec2 u_dir;
void main() {
  vec3 c = texture(u_source, v_uv).rgb * .2270270270;
  c += (texture(u_source, v_uv + u_dir * 1.3846153846).rgb + texture(u_source, v_uv - u_dir * 1.3846153846).rgb) * .3162162162;
  c += (texture(u_source, v_uv + u_dir * 3.2307692308).rgb + texture(u_source, v_uv - u_dir * 3.2307692308).rgb) * .0702702703;
  o = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene, u_glow, u_wide;
uniform float u_aspect, u_pxPerUnit, u_exposure, u_glowGain, u_wideGain, u_time;
uniform vec2 u_poly[${MAX_POLYGONS * MAX_VERTICES}];
uniform int u_polyCount[${MAX_POLYGONS}];
uniform int u_polys;
uniform vec3 u_glassColor;
uniform float u_edgeBase, u_edgeGlow, u_tint;

float sdPolygon(int start, int count, vec2 p) {
  vec2 v0 = u_poly[start];
  float d = dot(p - v0, p - v0);
  float s = 1.0;
  for (int i = 0; i < ${MAX_VERTICES}; i++) {
    if (i >= count) break;
    int j = i == 0 ? count - 1 : i - 1;
    vec2 vi = u_poly[start + i], vj = u_poly[start + j];
    vec2 e = vj - vi, w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}

void main() {
  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y);
  vec3 scene = texture(u_scene, v_uv).rgb;
  vec3 glow = texture(u_glow, v_uv).rgb;
  vec3 wide = texture(u_wide, v_uv).rgb;
  vec3 light = scene + glow * u_glowGain + wide * u_wideGain;

  // Glass: a thin edge that brightens where light crosses it, and a faint interior lit by what passes through.
  float d = 1e9;
  for (int q = 0; q < ${MAX_POLYGONS}; q++) { if (q >= u_polys) break; d = min(d, sdPolygon(q * ${MAX_VERTICES}, u_polyCount[q], p)); }
  float px = d * u_pxPerUnit;
  float edge = exp(-px * px * .45);
  float inside = 1.0 - smoothstep(-1.0, 1.0, px);
  float local = dot(glow, vec3(.2126, .7152, .0722));
  vec3 edgeCol = u_glassColor * (u_edgeBase + local * u_edgeGlow) * edge;
  vec3 tint = inside * u_tint * (u_glassColor * .06 + glow * vec3(.25, .4, .7) + wide * vec3(.15, .2, .35));
  light += edgeCol + tint;

  // ACES-style filmic curve, then gamma and a touch of dither against banding in the dark.
  vec3 x = light * u_exposure;
  vec3 mapped = clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0.0, 1.0);
  vec3 srgb = pow(mapped, vec3(1.0 / 2.2));
  float n = fract(sin(dot(gl_FragCoord.xy + vec2(u_time * 7.0, u_time * 3.0), vec2(12.9898, 78.233))) * 43758.5453);
  o = vec4(srgb + (n - .5) / 255.0, 1.0);
}`;

interface Source { x: number; y: number; weight: number; push: number; aimX: number; aimY: number }

/** Cheap per-frame numbers for profiling; published on window.prismDiagnostics for tooling, never read by the simulation. */
export interface PrismDiagnostics { traceMs: number; segments: number; rays: number; truncated: boolean }

export default defineSimulation({
  id: 'prism',
  title: 'Prism',
  description: 'White light through glass; the hand steers the beam and splits it into a spectrum.',
  params: {
    size: { kind: 'number', default: TRACE_DEFAULTS.size, min: .06, max: .45, step: .005, label: 'Prism size', description: 'Circumradius of the prism in uniform units (canvas height = 1).' },
    spin: { kind: 'number', default: .04, min: -.5, max: .5, step: .005, unit: 'rad/s', label: 'Spin', description: 'Slow rotation of the prism; negative spins the other way.' },
    glass: { kind: 'number', default: TRACE_DEFAULTS.glass, min: 1.2, max: 2.4, step: .01, label: 'Glass index', description: 'Cauchy A: the refractive index of the glass around the middle of the spectrum.' },
    dispersion: { kind: 'number', default: TRACE_DEFAULTS.dispersion, min: 0, max: 12, step: .1, label: 'Dispersion', description: 'Cauchy B as a multiple of real crown glass (0.004 µm²). 1 is physical; higher fans the spectrum wider.' },
    beam: { kind: 'number', default: TRACE_DEFAULTS.beam, min: .004, max: .08, step: .001, label: 'Beam width', description: 'Base width of the beam in uniform units. Pushing in widens it up to about 2.5×.' },
    rays: { kind: 'number', default: TRACE_DEFAULTS.rays, min: 8, max: 160, step: 1, label: 'Rays', description: 'Parallel rays across the beam at medium quality (scaled ×0.55 low, ×1.25 high). Each ray splits into one ray per wavelength inside the glass. Thinned automatically if a frame would exceed the segment budget.' },
    bounces: { kind: 'number', default: TRACE_DEFAULTS.bounces, min: 1, max: 8, step: 1, label: 'Bounces', description: 'Surface interactions that may spawn a Fresnel reflection. Transmission is always followed.' },
    glow: { kind: 'number', default: .7, min: 0, max: 2, step: .01, label: 'Glow', description: 'Strength of the bloom around the rays.' },
    idle: { kind: 'number', default: .3, min: 0, max: 1, step: .01, label: 'Idle brightness', description: 'Brightness of the orbiting beam when nobody is present.' },
    twin: { kind: 'boolean', default: false, label: 'Twin prism', description: 'Add a second prism so the spectrum can be split again.' },
  },
  signals: {
    spread: { min: 0, max: 1, description: 'Energy-weighted angular spread of the light leaving the scene: 0 for a single parallel beam, rising with dispersion and reflections.', smoothing: .15 },
    hue: { min: 0, max: 1, description: 'Energy-weighted mean hue of the light leaving in the dominant exit direction: about 0.3 for a complete fan, towards 0 (red) when its blue end is diverted by total internal reflection, towards 0.7 when the red end is.', smoothing: .15 },
    brightness: { min: 0, max: 1, description: 'Total energy leaving the scene relative to the launched beam(s).', smoothing: .15 },
    reflected: { min: 0, max: 1, description: 'Fraction of exiting energy that was reflected at least once (Fresnel or total internal reflection).', smoothing: .15 },
    incidence: { min: 0, max: 1, description: 'Angle of incidence at first contact with glass, 0 = head-on, 1 = grazing.', smoothing: .15 },
    inside: { min: 0, max: 1, description: 'Fraction of traced segments that lie inside glass.', smoothing: .15 },
  },
  create(ctx) {
    const gl = ctx.gl;
    const quality = QUALITY[ctx.quality];
    const spectrum: Spectrum = buildSpectrum(quality.spectrum * quality.interleave);
    const tracer = new Tracer(MAX_SEGMENTS);
    const polygons: Polygon[] = [createPolygon(MAX_VERTICES), createPolygon(MAX_VERTICES)];
    const activePolygons: Polygon[] = [];
    const beams: BeamSource[] = [];
    const beamPool: BeamSource[] = [0, 1].map(() => ({ x: 0, y: 0, dirX: 1, dirY: 0, width: .03, intensity: 0, rays: 1, gain: 1 }));
    const polyUniform = new Float32Array(MAX_POLYGONS * MAX_VERTICES * 2);
    const polyCounts = new Int32Array(MAX_POLYGONS);

    // GPU resources.
    const format = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    const lineProgram = new Program(gl, LINE_VS, LINE_FS, 'prism-lines');
    const downsample = quadProgram(gl, DOWNSAMPLE_FS, 'prism-down');
    const blur = quadProgram(gl, BLUR_FS, 'prism-blur');
    const composite = quadProgram(gl, COMPOSITE_FS, 'prism-composite');
    const vbo = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!vbo || !vao) throw new Error('Could not allocate the prism vertex buffer.');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_SEGMENTS * SEGMENT_STRIDE * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, SEGMENT_STRIDE * 4, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEGMENT_STRIDE * 4, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    let width = ctx.width, height = ctx.height, aspect = ctx.aspect;
    let scene: Fbo | null = null, half: Fbo | null = null, quarterA: Fbo | null = null, quarterB: Fbo | null = null, wide: Fbo | null = null;
    function allocate() {
      for (const f of [scene, half, quarterA, quarterB, wide]) f?.dispose();
      const sw = Math.max(8, Math.round(width * quality.sceneScale)), sh = Math.max(8, Math.round(height * quality.sceneScale));
      const hw = Math.max(4, sw >> 1), hh = Math.max(4, sh >> 1), qw = Math.max(2, sw >> 2), qh = Math.max(2, sh >> 2);
      scene = new Fbo(gl, sw, sh, format); half = new Fbo(gl, hw, hh, format);
      quarterA = new Fbo(gl, qw, qh, format); quarterB = new Fbo(gl, qw, qh, format); wide = new Fbo(gl, qw, qh, format);
    }
    allocate();

    // Simulation state. All motion is smoothed so nothing snaps when hands flicker.
    const primary: Source = { x: 0, y: 0, weight: 0, push: 0, aimX: 0, aimY: 0 };
    const second: Source = { x: 0, y: 0, weight: 0, push: 0, aimX: 0, aimY: 0 };
    let time = 0, rotation = .3, orbit = 2.2, orbitX = 0, orbitY = 0, presence = 0;
    let initialised = false, dirty = true;
    /** Fraction of the requested rays actually launched; lowered when a frame hits the segment cap. */
    let rayBudget = 1;
    const diagnostics: PrismDiagnostics = { traceMs: 0, segments: 0, rays: 0, truncated: false };
    const global = globalThis as { prismDiagnostics?: PrismDiagnostics };
    global.prismDiagnostics = diagnostics;
    const raw: RawSignals = { spread: 0, hue: .3, brightness: 0, reflected: 0, incidence: 0, inside: 0 };
    const smooth = { spread: 0, hue: .3, brightness: 0, reflected: 0, incidence: 0, inside: 0 };

    const centreA = { x: 0, y: 0 }, centreB = { x: 0, y: 0 };
    function placePrisms(twin: boolean) { prismCentre(0, twin, aspect, centreA); prismCentre(1, twin, aspect, centreB); }

    /** Keep a beam origin outside every prism and inside the picture. */
    function settle(source: Source, size: number, twin: boolean) {
      source.x = clamp(source.x, .02, aspect - .02); source.y = clamp(source.y, .02, .98);
      const count = twin ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const c = i === 0 ? centreA : centreB;
        const dx = source.x - c.x, dy = source.y - c.y, dist = Math.sqrt(dx * dx + dy * dy), minDist = size * 1.15;
        if (dist < minDist) { const k = dist > 1e-6 ? minDist / dist : 0; source.x = dist > 1e-6 ? c.x + dx * k : c.x + minDist; source.y = dist > 1e-6 ? c.y + dy * k : c.y; }
      }
    }
    function aimTarget(source: Source, twin: boolean, out: { x: number; y: number }) {
      if (!twin) { out.x = centreA.x; out.y = centreA.y; return; }
      const da = (source.x - centreA.x) ** 2 + (source.y - centreA.y) ** 2, db = (source.x - centreB.x) ** 2 + (source.y - centreB.y) ** 2;
      const c = da <= db ? centreA : centreB; out.x = c.x; out.y = c.y;
    }
    const aim = { x: 0, y: 0 };

    function fillBeam(beam: BeamSource, source: Source, intensity: number, rays: number, baseWidth: number, sceneHeight: number) {
      let dx = source.aimX - source.x, dy = source.aimY - source.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-6) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
      beam.x = source.x; beam.y = source.y; beam.dirX = dx; beam.dirY = dy;
      beam.width = beamWidth(baseWidth, source.push);
      beam.intensity = intensity; beam.rays = rays;
      beam.gain = beamGain(beam.width, sceneHeight, rays);
    }

    function traceScene(params: { size: number; glass: number; dispersion: number; beam: number; rays: number; bounces: number; idle: number; twin: boolean }) {
      const twin = params.twin;
      activePolygons.length = 0;
      activePolygons.push(setRegularPolygon(polygons[0], 3, centreA.x, centreA.y, params.size, rotation));
      if (twin) activePolygons.push(setRegularPolygon(polygons[1], 3, centreB.x, centreB.y, params.size * .85, -rotation * .7 + .9));
      const sceneHeight = scene ? scene.height : height;
      const rays = rayCount(params.rays, quality, rayBudget);
      const primaryIntensity = params.idle + (1 - params.idle) * primary.weight;
      beams.length = 0;
      fillBeam(beamPool[0], primary, primaryIntensity, rays, params.beam, sceneHeight);
      beams.push(beamPool[0]);
      if (second.weight > .01) { fillBeam(beamPool[1], second, second.weight, Math.max(4, Math.round(rays * .6)), params.beam, sceneHeight); beams.push(beamPool[1]); }
      const t0 = performance.now();
      const stats = tracer.trace(activePolygons, beams, traceOptionsFor(quality, spectrum, params, aspect, CAUCHY_B_GLASS));
      diagnostics.traceMs = performance.now() - t0; diagnostics.segments = stats.segments; diagnostics.rays = stats.rays; diagnostics.truncated = stats.truncated;
      rayBudget = nextRayBudget(rayBudget, stats.truncated);
      tracer.signals(raw);
      // Polygon uniforms for the composite pass.
      for (let q = 0; q < MAX_POLYGONS; q++) {
        const poly = activePolygons[q];
        polyCounts[q] = poly ? poly.count : 0;
        if (!poly) continue;
        for (let v = 0; v < poly.count; v++) { polyUniform[(q * MAX_VERTICES + v) * 2] = poly.x[v]; polyUniform[(q * MAX_VERTICES + v) * 2 + 1] = poly.y[v]; }
      }
    }

    function updateSource(source: Source, hand: { position: { x: number; y: number; z: number }; push: number } | null, dt: number, size: number, twin: boolean, idleX: number, idleY: number, rest: boolean) {
      if (hand) {
        const p = toUniform(hand.position, aspect);
        if (!initialised || (source.weight < .001 && !rest)) { source.x = p.x; source.y = p.y; }
        source.x = approach(source.x, p.x, dt, .06); source.y = approach(source.y, p.y, dt, .06);
        source.weight = approach(source.weight, 1, dt, .25);
        source.push = approach(source.push, clamp01(hand.push), dt, .12);
      } else {
        source.weight = approach(source.weight, 0, dt, rest ? 1.6 : .8);
        source.push = approach(source.push, 0, dt, .5);
        if (rest) { source.x = approach(source.x, idleX, dt, 1.2); source.y = approach(source.y, idleY, dt, 1.2); }
      }
      settle(source, size, twin);
      aimTarget(source, twin, aim);
      if (!initialised) { source.aimX = aim.x; source.aimY = aim.y; }
      source.aimX = approach(source.aimX, aim.x, dt, .4); source.aimY = approach(source.aimY, aim.y, dt, .4);
    }

    function stepSignals(dt: number) {
      const k = .15;
      smooth.spread = approach(smooth.spread, raw.spread, dt, k);
      smooth.brightness = approach(smooth.brightness, raw.brightness, dt, k);
      smooth.reflected = approach(smooth.reflected, raw.reflected, dt, k);
      smooth.incidence = approach(smooth.incidence, raw.incidence, dt, k);
      smooth.inside = approach(smooth.inside, raw.inside, dt, k);
      smooth.hue = approach(smooth.hue, raw.hue, dt, k);
      for (const key of Object.keys(smooth) as (keyof typeof smooth)[]) smooth[key] = clamp01(smooth[key]);
    }

    return {
      step(input: SimInput, params) {
        const dt = input.dt;
        time = input.time; presence = input.presence;
        rotation += params.spin * dt;
        if (rotation > TAU) rotation -= TAU; else if (rotation < 0) rotation += TAU;
        placePrisms(params.twin);
        // Idle beam: a slow orbit around the picture, radius breathing a little so the incidence keeps changing.
        orbit += dt * (TAU / 48) * (1 - .6 * presence);
        const radius = Math.min(aspect / 2, .5) * (.84 + .06 * Math.sin(time * .21));
        orbitX = aspect / 2 + radius * Math.cos(orbit); orbitY = .5 + radius * Math.sin(orbit) * .96;
        const hands = input.hands;
        const first = input.primary;
        const other = hands.length > 1 ? hands.find(h => h !== first) ?? null : null;
        updateSource(primary, first, dt, params.size, params.twin, orbitX, orbitY, true);
        updateSource(second, other, dt, params.size, params.twin, orbitX, orbitY, false);
        initialised = true;
        stepSignals(dt);
        dirty = true;
      },
      render(frame, params) {
        if (frame.width !== width || frame.height !== height) { width = frame.width; height = frame.height; aspect = frame.aspect; allocate(); dirty = true; }
        aspect = frame.aspect;
        if (!initialised) { placePrisms(params.twin); primary.x = orbitX = aspect * .18; primary.y = orbitY = .3; primary.aimX = centreA.x; primary.aimY = centreA.y; second.aimX = centreA.x; second.aimY = centreA.y; }
        if (dirty) { traceScene(params); dirty = false; }
        if (!scene || !half || !quarterA || !quarterB || !wide) return;
        const count = tracer.count;

        // 1. Additive lines into the half-float scene.
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, tracer.segments, 0, count * SEGMENT_STRIDE);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        scene.clear(0, 0, 0, 1);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        lineProgram.use().f2('u_scale', 2 / aspect, 2).f1('u_pxPerUnit', scene.height).f1('u_halfWidth', LINE.halfWidth)
          .f1('u_core', LINE.core).f1('u_halo', LINE.halo).f1('u_haloGain', LINE.haloGain);
        gl.bindVertexArray(vao);
        if (count > 0) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);

        // 2. Down to a quarter, blur tight, blur wide.
        half.bind(); downsample.use().texture('u_source', scene.texture, 0).f2('u_texel', 1 / half.width, 1 / half.height); drawQuad(gl);
        quarterA.bind(); downsample.use().texture('u_source', half.texture, 0).f2('u_texel', 1 / quarterA.width, 1 / quarterA.height); drawQuad(gl);
        const tx = 1 / quarterA.width, ty = 1 / quarterA.height;
        quarterB.bind(); blur.use().texture('u_source', quarterA.texture, 0).f2('u_dir', tx, 0); drawQuad(gl);
        quarterA.bind(); blur.use().texture('u_source', quarterB.texture, 0).f2('u_dir', 0, ty); drawQuad(gl);
        quarterB.bind(); blur.use().texture('u_source', quarterA.texture, 0).f2('u_dir', tx * 2.5, 0); drawQuad(gl);
        wide.bind(); blur.use().texture('u_source', quarterB.texture, 0).f2('u_dir', 0, ty * 2.5); drawQuad(gl);

        // 3. Composite with the glass and the filmic curve.
        bindScreen(gl, frame.width, frame.height);
        composite.use().texture('u_scene', scene.texture, 0).texture('u_glow', quarterA.texture, 1).texture('u_wide', wide.texture, 2)
          .f1('u_aspect', aspect).f1('u_pxPerUnit', frame.height).f1('u_exposure', 1.0)
          .f1('u_glowGain', params.glow * .9).f1('u_wideGain', params.glow * .6).f1('u_time', frame.time % 100)
          .f2v('u_poly', polyUniform).i1('u_polys', activePolygons.length)
          .f3('u_glassColor', .62, .74, .92).f1('u_edgeBase', .08 + .05 * presence).f1('u_edgeGlow', 2.2).f1('u_tint', .6);
        gl.uniform1iv(composite.location('u_polyCount'), polyCounts);
        drawQuad(gl);
      },
      signals() { return smooth; },
      resize(w, h) { width = w; height = h; aspect = w / Math.max(1, h); allocate(); dirty = true; },
      dispose() {
        for (const f of [scene, half, quarterA, quarterB, wide]) f?.dispose();
        scene = half = quarterA = quarterB = wide = null;
        gl.deleteBuffer(vbo); gl.deleteVertexArray(vao);
        lineProgram.dispose(); downsample.dispose(); blur.dispose(); composite.dispose();
        if (global.prismDiagnostics === diagnostics) delete global.prismDiagnostics;
      },
    };
  },
});
