/**
 * Prism — white light and glass, in the volume.
 *
 * A glass prism stands in the middle of the volume, its axis vertical, on a
 * dark floor. The hand is the light source: light travels in a horizontal
 * plane at the hand's height, from the hand's (x, z) toward the prism's axis,
 * so walking around the prism — and pushing in, which walks the source toward
 * the back wall — changes the incidence angle and the spectrum fans out, folds
 * and reflects inside the glass. Raising the hand above the glass lets the
 * beam pass over it; an open hand widens the beam. Rays end on the walls of
 * the volume and leave a splash of colour there. With nobody there a faint
 * idle beam orbits the prism at mid height.
 *
 * Physics (Snell, Fresnel, Cauchy dispersion, total internal reflection)
 * lives in `optics.ts` as a 2D ray tracer over the light plane (the tracer's
 * y is the volume's z). Rendering lifts each traced segment to its plane's
 * height and projects it with the prism's camera in the vertex shader, then
 * expands it into a thin anti-aliased quad accumulated additively into a
 * half-float target so overlapping wavelengths add back to white; the same
 * segments drawn at y = 0 are the beam's footprint on the floor, and a disc
 * per wall-ending segment is its splash. The material composite intersects
 * closed glass against those same polygon planes, refracts the stone table
 * through entry and exit faces, and reflects procedural studio lights. The
 * bounded camera-ray material is in `material.ts`; it replaces additive faces
 * and edges without adding a rendering pass.
 *
 * Hands are bodies in the light plane (`solids.ts`): the depth scan when the
 * source has one (the primary representation), otherwise the skeleton's
 * capsules, become opaque occluders in the tracer's plane. A ray that meets
 * one stops there, its energy is counted in the `occluded` signal, and the
 * hit is drawn as a warm splash on the skin, so a second hand held into the
 * fan throws a shadow through the spectrum and fingers slice it. The beam's
 * own hand is the emitter: what lies within a palm's reach of its origin is
 * passed through by a ray's first segment, and rays start just outside the
 * palm. The solids themselves are drawn as faint ghosts at their real height
 * (the scan marched as a thin shell, or the capsule field sphere-traced).
 *
 * The camera is the window construction with the eye raised above the
 * volume (`geometry.ts`): the shared window camera sits at mid height and
 * would see the light plane edge-on.
 *
 * The segment cap (`MAX_SEGMENTS`) is a safety net, not a working limit: an
 * adaptive ray budget lowers the ray count whenever a frame is truncated and
 * creeps it back up afterwards, and the tracer launches rays in an
 * interleaved order across the beam so a truncated frame thins the whole
 * beam evenly instead of dropping one side of it. Tunables that the tests
 * reproduce live in `config.ts`.
 */
import { defineSimulation, type SimInput, type Vec3 } from '../../core/types';
import type { HandState } from '../../input/types';
import { approach, clamp, clamp01 } from '../../core/math';
import { bindScreen, Fbo, pickFormat } from '../../gl/fbo';
import { createPackedHands, handSdfGlsl, packHands } from '../../gl/hand';
import { SurfaceTexture, surfaceGlsl } from '../../gl/surface';
import { GLSL_HEADER, Program } from '../../gl/program';
import { drawQuad, quadProgram } from '../../gl/quad';
import {
  beamGain, beamWidth, CLEARANCE_MAX, FLOOR_LINE_GAIN, GHOST, idleOrbit, lightPlane, LINE, MAX_OCCLUDER_GROUPS, MAX_OCCLUDERS, MAX_POLYGONS,
  MAX_SEGMENTS, MAX_VERTICES, nextRayBudget, PALM_REACH, prismCentre, prismRadius, QUALITY, rayCount, SCAN_THICKNESS, SCAN_TOLERANCE, SKIN_SPLASH,
  SPLASH, TOUCH_MARGIN, TRACE_DEFAULTS, traceOptionsFor, type PlanePoint,
} from './config';
import {
  buildSpectrum, CAUCHY_B_GLASS, createPolygon, HIT_STRIDE, MAX_HITS, OccluderSet, SEGMENT_STRIDE, setRegularPolygon, Tracer,
  type BeamSource, type Polygon, type RawSignals, type Spectrum,
} from './optics';
import { addHandOccluders, addScanOccluders, type Emitter } from './solids';
import { EYE_HEIGHT, prismCamera } from './geometry';
import { COMPOSITE_FS } from './material';

const TAU = Math.PI * 2;
/** Height the idle beam orbits at, in uniform units. */
const IDLE_HEIGHT = .5;
/** Beam openness the source relaxes to with no hand. */
const IDLE_OPENNESS = .5;
// Line quads: each segment instance is expanded in the vertex shader after projection, so the fan recedes with
// perspective while the line itself keeps a crisp core and halo measured in scene pixels. The endpoints' heights
// come from attribute 2: a constant containing the light plane's height for traced segments.
const LINE_VS = `${GLSL_HEADER}
layout(location = 0) in vec4 a_seg;   // x0 z0 x1 z1 in the light plane, uniform units
layout(location = 1) in vec4 a_col;   // r g b intensity
layout(location = 2) in vec2 a_y;     // height of each endpoint
uniform mat4 u_matrix;                // world → clip
uniform float u_eye;
uniform vec2 u_viewport;              // scene target size in pixels
uniform float u_halfWidth;            // quad half width in scene pixels
uniform float u_gain;
out vec2 v_lin;                       // along, across (scene pixels)
out float v_int;
flat out float v_len;
flat out vec3 v_rgb;
void main() {
  int id = gl_VertexID - (gl_VertexID / 6) * 6;
  float along = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float across = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  vec4 c0 = u_matrix * vec4(a_seg.x, a_y.x, a_seg.y, 1.0);
  vec4 c1 = u_matrix * vec4(a_seg.z, a_y.y, a_seg.w, 1.0);
  // Endpoints lie inside the volume, so w > 0 and no clipping is needed before the divide.
  vec2 s0 = (c0.xy / c0.w * 0.5 + 0.5) * u_viewport;
  vec2 s1 = (c1.xy / c1.w * 0.5 + 0.5) * u_viewport;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float t = along * len + (along * 2.0 - 1.0) * u_halfWidth;
  vec2 p = s0 + dir * t + nrm * (across * u_halfWidth);
  v_lin = vec2(t, across * u_halfWidth);
  v_len = len;
  v_rgb = a_col.rgb;
  // Radiance is conserved: rays pack closer together deeper in, so each carries eye / w of its glass-plane intensity.
  v_int = a_col.a * u_gain * u_eye / mix(c0.w, c1.w, along);
  gl_Position = vec4(p / u_viewport * 2.0 - 1.0, 0.0, 1.0);
}`;

const LINE_FS = `${GLSL_HEADER}
in vec2 v_lin; in float v_int; flat in float v_len; flat in vec3 v_rgb; out vec4 o;
uniform float u_core, u_halo, u_haloGain;
void main() {
  float dAlong = max(0.0, max(-v_lin.x, v_lin.x - v_len));
  float d2 = dAlong * dAlong + v_lin.y * v_lin.y;
  float core = exp(-d2 / (u_core * u_core));
  float halo = exp(-sqrt(d2) / u_halo) * u_haloGain;
  o = vec4(v_rgb * (v_int * (core + halo)), 1.0);
}`;

// Wall splashes: the same segment instances again; those ending on a wall become a disc lying in that wall,
// the rest collapse to nothing.
const SPLASH_VS = `${GLSL_HEADER}
layout(location = 0) in vec4 a_seg;
layout(location = 1) in vec4 a_col;
layout(location = 2) in vec2 a_y;
uniform mat4 u_matrix;
uniform vec2 u_volume;                // aspect, depth
uniform float u_radius, u_gain;
out vec2 v_uv; flat out vec3 v_rgb; flat out float v_int;
void main() {
  int id = gl_VertexID - (gl_VertexID / 6) * 6;
  float a = (id == 1 || id == 2 || id == 4) ? 1.0 : -1.0;
  float b = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  vec2 e = a_seg.zw;
  const float eps = 1e-4;
  bool xWall = e.x <= eps || e.x >= u_volume.x - eps;
  bool zWall = e.y <= eps || e.y >= u_volume.y - eps;
  v_uv = vec2(a, b); v_rgb = a_col.rgb; v_int = a_col.a * u_gain;
  if (!xWall && !zWall) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); v_int = 0.0; return; }
  vec3 across = xWall ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 p = vec3(e.x, a_y.y, e.y) + vec3(0.0, u_radius * a, 0.0) + across * (u_radius * b);
  gl_Position = u_matrix * vec4(p, 1.0);
}`;

const SPLASH_FS = `${GLSL_HEADER}
in vec2 v_uv; flat in vec3 v_rgb; flat in float v_int; out vec4 o;
void main() {
  float d2 = dot(v_uv, v_uv);
  float s = exp(-d2 * 3.0) * (1.0 - smoothstep(0.6, 1.0, d2));
  o = vec4(v_rgb * (v_int * s), 1.0);
}`;

// Splashes on skin: one disc per ray that ended on a solid, lying in the solid's tangent plane at the hit
// (the tracer records the surface normal there), drawn with the wall splash's fragment shader.
const SKIN_VS = `${GLSL_HEADER}
layout(location = 0) in vec4 a_hit;   // x z nx nz: the point in the light plane and the normal's in-plane part
layout(location = 1) in vec4 a_col;   // r g b intensity
layout(location = 2) in vec2 a_h;     // plane height, the normal's vertical component
uniform mat4 u_matrix;
uniform float u_radius, u_gain;
uniform vec3 u_tint;
out vec2 v_uv; flat out vec3 v_rgb; flat out float v_int;
void main() {
  int id = gl_VertexID - (gl_VertexID / 6) * 6;
  float a = (id == 1 || id == 2 || id == 4) ? 1.0 : -1.0;
  float b = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  vec3 p = vec3(a_hit.x, a_h.x, a_hit.y);
  vec3 n = normalize(vec3(a_hit.z, a_h.y, a_hit.w));
  vec3 ref = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(n, ref)), v = cross(n, u);
  v_uv = vec2(a, b); v_rgb = a_col.rgb * u_tint; v_int = a_col.a * u_gain;
  gl_Position = u_matrix * vec4(p + n * 0.003 + u * (u_radius * a) + v * (u_radius * b), 1.0);
}`;

// The solids themselves, as faint ghosts at their real height: the depth scan marched with the prism's camera
// (only inside the scanned body's projected box), or the skeleton's capsule field sphere-traced where a ray meets a
// hand's bounding sphere. Additive into the scene target, so the glow picks them up a little.
const GHOST_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform float u_aspect, u_depth, u_eye, u_eyeY, u_ghost;
uniform vec3 u_color;
uniform vec4 u_scanBox;               // ndc box of the scanned body: x0 y0 x1 y1 (empty when nothing is scanned)
uniform vec3 u_scanZ;                 // world z range of the scanned body (front, back) and the shell's thickness
${handSdfGlsl()}
${surfaceGlsl()}
vec3 handNormal(vec3 p) {
  vec2 e = vec2(0.004, 0.0);
  return normalize(vec3(handDistance(p + e.xyy) - handDistance(p - e.xyy), handDistance(p + e.yxy) - handDistance(p - e.yxy), handDistance(p + e.yyx) - handDistance(p - e.yyx)));
}
vec3 skin(vec3 n, vec3 rd, float depth01) {
  float rim = pow(1.0 - abs(dot(n, -rd)), 2.5);
  float lit = 0.75 + 0.25 * n.y;
  return u_color * (${GHOST.base.toFixed(4)} * lit + ${GHOST.rim.toFixed(4)} * rim) * u_ghost / (1.0 + 0.9 * depth01);
}
bool inShell(vec3 p) {
  vec2 xy = vec2(p.x / u_aspect, p.y);
  if (xy.x < 0.0 || xy.x > 1.0 || xy.y < 0.0 || xy.y > 1.0) return false;
  vec2 s = texture(u_surface, xy).rg;
  float zs = s.r * u_depth;
  return s.g > 0.5 && p.z >= zs && p.z <= zs + u_scanZ.z;
}
// March the ray through the scanned body's depth range until it is inside the shell (behind the scanned front, within its
// thickness): the shell is a skin of the volume, not everything behind it, which matters from a raised eye.
vec4 scanHit(vec3 ro, vec3 rd) {
  if (rd.z <= 1e-5) return vec4(0.0);
  float t0 = max(0.0, (u_scanZ.x - ro.z) / rd.z), t1 = (u_scanZ.y - ro.z) / rd.z;
  if (t1 <= t0) return vec4(0.0);
  float dt = (t1 - t0) / 48.0;
  for (int i = 0; i <= 48; i++) {
    vec3 p = ro + rd * (t0 + dt * float(i));
    if (!inShell(p)) continue;
    vec3 a = p - rd * dt, b = p;
    for (int j = 0; j < 4; j++) { vec3 m = (a + b) * 0.5; if (inShell(m)) b = m; else a = m; }
    return vec4(b, 1.0);
  }
  return vec4(0.0);
}
void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  vec3 ro = vec3(u_aspect * 0.5, u_eyeY, -u_eye);
  vec3 rd = normalize(vec3(ndc.x * u_aspect * 0.5, 0.5 + ndc.y * 0.5 - u_eyeY, u_eye));
  vec3 light = vec3(0.0);
  if (u_surfaceReady == 1 && all(greaterThanEqual(ndc, u_scanBox.xy)) && all(lessThanEqual(ndc, u_scanBox.zw))) {
    vec4 hit = scanHit(ro, rd);
    if (hit.w > 0.0) light += skin(surfaceNormal(vec2(hit.x / u_aspect, hit.y)), rd, clamp(hit.z / u_depth, 0.0, 1.0));
  }
  if (u_capsuleCount > 0) {
    vec2 span = handBoundsHit(ro, rd);
    if (span.y > max(span.x, 0.0)) {
      float t = max(span.x, 0.0), tEnd = span.y, hit = -1.0;
      for (int i = 0; i < 32; i++) {
        vec3 q = ro + rd * t;
        float d = handDistance(q);
        if (d < 0.0015) { hit = t; break; }
        t += max(d, 0.0025);
        if (t > tEnd) break;
      }
      if (hit > 0.0) { vec3 q = ro + rd * hit; light += skin(handNormal(q), rd, clamp(q.z / u_depth, 0.0, 1.0)); }
    }
  }
  o = vec4(light, 1.0);
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

/** A light source: position in the volume (uniform units), beam openness, presence weight, the point in the plane it aims at, and the hand it belongs to (−1 for none). */
interface Source { x: number; y: number; z: number; open: number; weight: number; aimX: number; aimZ: number; handId: number }

/** GPU side of one beam: its segment buffer and its skin-hit buffer, how many of each it holds, and the height of its light plane. */
interface BeamSlot { vbo: WebGLBuffer; vao: WebGLVertexArrayObject; count: number; hitVbo: WebGLBuffer; hitVao: WebGLVertexArrayObject; hitCount: number; planeY: number }

/** Cheap per-frame numbers for profiling; published on window.prismDiagnostics for tooling, never read by the simulation. */
export interface PrismDiagnostics {
  traceMs: number; segments: number; rays: number; truncated: boolean;
  /** Solids in the last traced plane, rays that ended on one, whether they came from a depth scan, and the primary beam's plane and origin (sim space). */
  occluders: number; hits: number; scanned: boolean; planeY: number; sourceX: number; sourceZ: number;
}

export default defineSimulation({
  id: 'prism',
  title: 'Prism',
  description: 'Polished optical glass on a stone light table. Reflected studio lights reveal the faces; the table refracts through the solid. Carry white light around the prism to split a spectrum across the room.',
  params: {
    size: { kind: 'number', default: TRACE_DEFAULTS.size, min: .06, max: .45, step: .005, label: 'Prism size', description: 'Circumradius of the prism in the light plane, in uniform units (canvas height = 1).' },
    height: { kind: 'number', default: TRACE_DEFAULTS.height, min: .1, max: 1, step: .01, label: 'Prism height', description: 'Height of the glass above the floor in uniform units. A hand above it sends the beam over the glass.' },
    spin: { kind: 'number', default: .04, min: -.5, max: .5, step: .005, unit: 'rad/s', label: 'Spin', description: 'Slow rotation of the prism about its axis; negative spins the other way.' },
    glass: { kind: 'number', default: TRACE_DEFAULTS.glass, min: 1.2, max: 2.4, step: .01, label: 'Glass index', description: 'Cauchy A: the refractive index of the glass around the middle of the spectrum.' },
    dispersion: { kind: 'number', default: TRACE_DEFAULTS.dispersion, min: 0, max: 12, step: .1, label: 'Dispersion', description: 'Cauchy B as a multiple of real crown glass (0.004 µm²). 1 is physical; higher fans the spectrum wider.' },
    beam: { kind: 'number', default: TRACE_DEFAULTS.beam, min: .006, max: .1, step: .001, label: 'Beam width', description: 'Width of the beam from an open hand, in uniform units. A closed hand narrows it to about a third; sources without hand shape use the full width.' },
    rays: { kind: 'number', default: TRACE_DEFAULTS.rays, min: 8, max: 160, step: 1, label: 'Rays', description: 'Parallel rays across the beam at medium quality (scaled ×0.55 low, ×1.25 high). Each ray splits into one ray per wavelength inside the glass. Thinned automatically if a frame would exceed the segment budget.' },
    bounces: { kind: 'number', default: TRACE_DEFAULTS.bounces, min: 1, max: 8, step: 1, label: 'Bounces', description: 'Surface interactions that may spawn a Fresnel reflection. Transmission is always followed.' },
    glow: { kind: 'number', default: .7, min: 0, max: 2, step: .01, label: 'Glow', description: 'Strength of the bloom around the rays.' },
    roughness: { kind: 'number', default: .08, min: .02, max: .6, step: .01, label: 'Glass polish', description: 'Reflection softness: low is optical polish, high broadens the studio highlights.' },
    floor: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Floor', description: 'Brightness of the stone table and the light deposited on it.' },
    idle: { kind: 'number', default: .3, min: 0, max: 1, step: .01, label: 'Idle brightness', description: 'Brightness of the orbiting beam when nobody is present.' },
    twin: { kind: 'boolean', default: false, label: 'Twin prism', description: 'Add a second prism so the spectrum can be split again.' },
  },
  signals: {
    spread: { min: 0, max: 1, description: 'Energy-weighted angular spread of the light leaving the scene: 0 for a single parallel beam, rising with dispersion and reflections.', smoothing: .15 },
    hue: { min: 0, max: 1, description: 'Energy-weighted mean hue of the light leaving in the dominant exit direction: about 0.3 for a complete fan, towards 0 (red) when its blue end is diverted by total internal reflection, towards 0.7 when the red end is.', smoothing: .15 },
    brightness: { min: 0, max: 1, description: 'Total energy leaving the scene relative to the launched beam.', smoothing: .15 },
    reflected: { min: 0, max: 1, description: 'Fraction of exiting energy that was reflected at least once (Fresnel or total internal reflection).', smoothing: .15 },
    incidence: { min: 0, max: 1, description: 'Angle of incidence at first contact with glass, 0 = head-on, 1 = grazing; 0 while the beam passes over the glass.', smoothing: .15 },
    inside: { min: 0, max: 1, description: 'Fraction of traced segments that lie inside glass.', smoothing: .15 },
    elevation: { min: 0, max: 1, description: 'Height of the light plane: the hand\'s y in the volume, smoothed; 0.5 for the idle beam.', smoothing: .15 },
    occluded: { min: 0, max: 1, description: 'Fraction of the launched beam energy stopped by a body in the light plane (a hand or the depth scan), across both beams, smoothed.', smoothing: .15 },
  },
  create(ctx) {
    const gl = ctx.gl;
    const quality = QUALITY[ctx.quality];
    const depth = ctx.depth;
    const spectrum: Spectrum = buildSpectrum(quality.spectrum * quality.interleave);
    const tracer = new Tracer(MAX_SEGMENTS);
    const polygons: Polygon[] = [createPolygon(MAX_VERTICES), createPolygon(MAX_VERTICES)];
    const activePolygons: Polygon[] = [];
    const noPolygons: Polygon[] = [];
    const beamPool: BeamSource[] = [0, 1].map(() => ({ x: 0, y: 0, dirX: 1, dirY: 0, width: .03, intensity: 0, rays: 1, gain: 1, clearance: { x: 0, y: 0, radius: 0 } }));
    const beamList: BeamSource[] = [beamPool[0]];
    const glassPlanes = new Float32Array(MAX_POLYGONS * 3 * 4);

    // GPU resources.
    const format = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    const lineProgram = new Program(gl, LINE_VS, LINE_FS, 'prism-lines');
    const splashProgram = new Program(gl, SPLASH_VS, SPLASH_FS, 'prism-splash');
    const skinProgram = new Program(gl, SKIN_VS, SPLASH_FS, 'prism-skin');
    const downsample = quadProgram(gl, DOWNSAMPLE_FS, 'prism-down');
    const blur = quadProgram(gl, BLUR_FS, 'prism-blur');
    const composite = quadProgram(gl, COMPOSITE_FS, 'prism-composite');
    const ghost = quadProgram(gl, GHOST_FS, 'prism-ghost');
    const surfaceTexture = new SurfaceTexture(gl);

    function buffer(bytes: number): WebGLBuffer {
      const b = gl.createBuffer();
      if (!b) throw new Error('Could not allocate a prism vertex buffer.');
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return b;
    }
    function vertexArray(): WebGLVertexArrayObject {
      const v = gl.createVertexArray();
      if (!v) throw new Error('Could not allocate a prism vertex array.');
      return v;
    }
    /**
     * One beam's buffers: segments (attributes 0 and 1 per instance from the tracer's layout, attribute 2 left constant)
     * and skin hits (attributes 0, 1, 2 per instance from the tracer's hit layout).
     */
    function beamSlot(): BeamSlot {
      const vbo = buffer(MAX_SEGMENTS * SEGMENT_STRIDE * 4), vao = vertexArray();
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, SEGMENT_STRIDE * 4, 0); gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEGMENT_STRIDE * 4, 16); gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const hitVbo = buffer(MAX_HITS * HIT_STRIDE * 4), hitVao = vertexArray();
      gl.bindVertexArray(hitVao); gl.bindBuffer(gl.ARRAY_BUFFER, hitVbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, HIT_STRIDE * 4, 0); gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, HIT_STRIDE * 4, 16); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, HIT_STRIDE * 4, 32); gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return { vbo, vao, count: 0, hitVbo, hitVao, hitCount: 0, planeY: IDLE_HEIGHT };
    }
    const slots: BeamSlot[] = [beamSlot(), beamSlot()];
    let width = ctx.width, height = ctx.height, aspect = ctx.aspect;
    let camera = prismCamera(aspect, depth);
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
    const primary: Source = { x: 0, y: IDLE_HEIGHT, z: 0, open: IDLE_OPENNESS, weight: 0, aimX: 0, aimZ: 0, handId: -1 };
    const second: Source = { x: 0, y: IDLE_HEIGHT, z: 0, open: IDLE_OPENNESS, weight: 0, aimX: 0, aimZ: 0, handId: -1 };
    let time = 0, rotation = .3, orbit = 2.2, presence = 0;
    const idle: PlanePoint = { x: 0, z: 0 };
    let initialised = false, dirty = true;
    /** Fraction of the requested rays actually launched; lowered when a frame hits the segment cap. */
    let rayBudget = 1;
    // The solids: the tracked hands and the depth scan from the last step, the occluders built from them per light
    // plane, and their GPU forms for the ghost pass (a scan texture, or packed capsules when there is no scan).
    let hands: readonly HandState[] = [];
    let surface: SimInput['surface'] = null;
    const occluders = new OccluderSet(MAX_OCCLUDERS, MAX_OCCLUDER_GROUPS);
    const emitter: Emitter = { x: 0, y: 0, z: 0, reach: PALM_REACH, touch: TOUCH_MARGIN };
    const packed = createPackedHands();
    const scanBox = new Float32Array([2, 2, -2, -2]), scanZ = new Float32Array([0, 0]);
    const diagnostics: PrismDiagnostics = { traceMs: 0, segments: 0, rays: 0, truncated: false, occluders: 0, hits: 0, scanned: false, planeY: 0, sourceX: 0, sourceZ: 0 };
    const global = globalThis as { prismDiagnostics?: PrismDiagnostics };
    global.prismDiagnostics = diagnostics;
    const raw: RawSignals = { spread: 0, hue: .3, brightness: 0, reflected: 0, incidence: 0, inside: 0, occluded: 0 };
    const smooth = { spread: 0, hue: .3, brightness: 0, reflected: 0, incidence: 0, inside: 0, elevation: IDLE_HEIGHT, occluded: 0 };

    const centreA: PlanePoint = { x: 0, z: 0 }, centreB: PlanePoint = { x: 0, z: 0 };
    function placePrisms(twin: boolean) { prismCentre(0, twin, aspect, depth, centreA); prismCentre(1, twin, aspect, depth, centreB); }

    /** Keep a beam origin inside the volume and outside every prism's footprint. */
    function settle(source: Source, radius: number, twin: boolean) {
      source.x = clamp(source.x, .02, aspect - .02); source.z = clamp(source.z, .02, depth - .02); source.y = clamp01(source.y);
      const count = twin ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const c = i === 0 ? centreA : centreB;
        const dx = source.x - c.x, dz = source.z - c.z, dist = Math.sqrt(dx * dx + dz * dz), minDist = radius * 1.15;
        if (dist < minDist) { const k = dist > 1e-6 ? minDist / dist : 0; source.x = dist > 1e-6 ? c.x + dx * k : c.x + minDist; source.z = dist > 1e-6 ? c.z + dz * k : c.z; }
      }
    }
    const aim: PlanePoint = { x: 0, z: 0 };
    function aimTarget(source: Source, twin: boolean, out: PlanePoint) {
      if (!twin) { out.x = centreA.x; out.z = centreA.z; return; }
      const da = (source.x - centreA.x) ** 2 + (source.z - centreA.z) ** 2, db = (source.x - centreB.x) ** 2 + (source.z - centreB.z) ** 2;
      const c = da <= db ? centreA : centreB; out.x = c.x; out.z = c.z;
    }

    function fillBeam(beam: BeamSource, source: Source, intensity: number, rays: number, baseWidth: number, sceneHeight: number) {
      let dx = source.aimX - source.x, dz = source.aimZ - source.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-6) { dx /= len; dz /= len; } else { dx = 1; dz = 0; }
      beam.x = source.x; beam.y = source.z; beam.dirX = dx; beam.dirY = dz;
      beam.width = beamWidth(baseWidth, source.open);
      beam.intensity = intensity; beam.rays = rays;
      beam.gain = beamGain(beam.width, sceneHeight, rays);
    }

    /** The closed glass uses exactly the polygon planes traced by the beam solver. */
    function buildGlass(twin: boolean) {
      for (let q = 0; q < (twin ? 2 : 1); q++) {
        const p = polygons[q];
        for (let k = 0; k < 3; k++) {
          const o = (q * 3 + k) * 4;
          glassPlanes[o] = p.nx[k]; glassPlanes[o + 1] = 0; glassPlanes[o + 2] = p.ny[k];
          glassPlanes[o + 3] = p.nx[k] * p.x[k] + p.ny[k] * p.y[k];
        }
      }
    }

    /**
     * The solids in one beam's light plane: the depth scan when there is one (the primary representation), otherwise
     * every hand's capsules. The beam's own hand is the emitter: what lies within a palm's reach of it is passed through
     * by the first segment, and the clearance disc (the palm's extent, capped) is where the rays start.
     */
    function buildOccluders(planeY: number, source: Source, beam: BeamSource) {
      let own: HandState | undefined;
      if (source.handId >= 0) for (const h of hands) if (h.id === source.handId) { own = h; break; }
      const px = own ? own.position.x * aspect : source.x, pz = own ? own.position.z * depth : source.z;
      emitter.x = px; emitter.y = planeY; emitter.z = pz; emitter.reach = PALM_REACH; emitter.touch = beam.width / 2 + TOUCH_MARGIN;
      occluders.begin(planeY, px, pz);
      if (surface) addScanOccluders(occluders, surface, planeY, aspect, depth, SCAN_THICKNESS, SCAN_TOLERANCE, own ? emitter : null);
      else for (const hand of hands) addHandOccluders(occluders, hand, aspect, depth, own === hand ? emitter : null);
      const clearance = beam.clearance!;
      clearance.x = px; clearance.y = pz; clearance.radius = Math.min(CLEARANCE_MAX, occluders.palmReach);
    }

    /** The scanned body's box on the screen (ndc), from the scan's extent in sim space projected through the prism's camera, so the ghost pass marches only there. */
    const corner: Vec3 = { x: 0, y: 0, z: 0 };
    function scanBounds(field: NonNullable<SimInput['surface']>) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      const w = field.width, hgt = field.height;
      for (let row = 0; row < hgt; row++) for (let col = 0; col < w; col++) {
        const i = row * w + col;
        if (field.mask[i] === 0) continue;
        if (col < x0) x0 = col; if (col + 1 > x1) x1 = col + 1; if (row < y0) y0 = row; if (row + 1 > y1) y1 = row + 1;
        const z = field.z[i]; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      if (x0 === Infinity) { scanBox[0] = scanBox[1] = 2; scanBox[2] = scanBox[3] = -2; scanZ[0] = scanZ[1] = 0; return; }
      scanZ[0] = z0 * depth; scanZ[1] = Math.min(depth, (z1 + SCAN_THICKNESS) * depth);
      let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
      for (let c = 0; c < 8; c++) {
        corner.x = ((c & 1) ? x1 : x0) / w * aspect; corner.y = ((c & 2) ? y1 : y0) / hgt; corner.z = Math.min(depth, ((c & 4) ? z1 + SCAN_THICKNESS : z0) * depth);
        const p = camera.project(corner);
        if (p.x < nx0) nx0 = p.x; if (p.x > nx1) nx1 = p.x; if (p.y < ny0) ny0 = p.y; if (p.y > ny1) ny1 = p.y;
      }
      const pad = .02;
      scanBox[0] = nx0 - pad; scanBox[1] = ny0 - pad; scanBox[2] = nx1 + pad; scanBox[3] = ny1 + pad;
    }

    /** Trace one beam into its slot and upload the segments and skin hits. The light meets the glass only if its plane is within the prism's height. */
    function traceBeam(slot: BeamSlot, beam: BeamSource, source: Source, planeY: number, prismHeight: number, options: ReturnType<typeof traceOptionsFor>) {
      buildOccluders(planeY, source, beam);
      beamList[0] = beam;
      const stats = tracer.trace(planeY <= prismHeight ? activePolygons : noPolygons, beamList, options, occluders);
      slot.count = stats.segments; slot.hitCount = tracer.hitCount; slot.planeY = planeY;
      gl.bindBuffer(gl.ARRAY_BUFFER, slot.vbo);
      if (slot.count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, tracer.segments, 0, slot.count * SEGMENT_STRIDE);
      gl.bindBuffer(gl.ARRAY_BUFFER, slot.hitVbo);
      if (slot.hitCount > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, tracer.hits, 0, slot.hitCount * HIT_STRIDE);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return stats;
    }

    function traceScene(params: { size: number; height: number; glass: number; dispersion: number; beam: number; rays: number; bounces: number; idle: number; twin: boolean }) {
      const twin = params.twin, radius = prismRadius(params.size, aspect, depth);
      activePolygons.length = 0;
      activePolygons.push(setRegularPolygon(polygons[0], 3, centreA.x, centreA.z, radius, rotation));
      if (twin) activePolygons.push(setRegularPolygon(polygons[1], 3, centreB.x, centreB.z, radius * .85, -rotation * .7 + .9));
      buildGlass(twin);
      const sceneHeight = scene ? scene.height : height;
      const rays = rayCount(params.rays, quality, rayBudget);
      const options = traceOptionsFor(quality, spectrum, params, aspect, depth, CAUCHY_B_GLASS);
      const t0 = performance.now();
      // The primary beam: the signals describe this one (except `occluded`, which counts both beams).
      fillBeam(beamPool[0], primary, params.idle + (1 - params.idle) * primary.weight, rays, params.beam, sceneHeight);
      const a = traceBeam(slots[0], beamPool[0], primary, primary.y, params.height, options);
      let segments = a.segments, launched = a.rays, truncated = a.truncated, occludedEnergy = a.occluded, launchedEnergy = a.launched;
      let solids = occluders.count, hits = tracer.hitCount;
      tracer.signals(raw);
      // A second hand carries its own beam in its own plane.
      if (second.weight > .01) {
        fillBeam(beamPool[1], second, second.weight, Math.max(4, Math.round(rays * .6)), params.beam, sceneHeight);
        const b = traceBeam(slots[1], beamPool[1], second, second.y, params.height, options);
        segments += b.segments; launched += b.rays; truncated = truncated || b.truncated; occludedEnergy += b.occluded; launchedEnergy += b.launched;
        solids = Math.max(solids, occluders.count); hits += tracer.hitCount;
      } else { slots[1].count = 0; slots[1].hitCount = 0; }
      raw.occluded = launchedEnergy > 1e-9 ? clamp01(occludedEnergy / launchedEnergy) : 0;
      diagnostics.traceMs = performance.now() - t0; diagnostics.segments = segments; diagnostics.rays = launched; diagnostics.truncated = truncated;
      diagnostics.occluders = solids; diagnostics.hits = hits; diagnostics.scanned = surface !== null;
      diagnostics.planeY = primary.y; diagnostics.sourceX = primary.x / aspect; diagnostics.sourceZ = primary.z / depth;
      rayBudget = nextRayBudget(rayBudget, truncated);
    }

    const plane: Vec3 = { x: 0, y: 0, z: 0 };
    function updateSource(source: Source, hand: HandState | null, dt: number, radius: number, twin: boolean, rest: boolean) {
      source.handId = hand ? hand.id : -1;
      if (hand) {
        lightPlane(hand.position, aspect, depth, plane);
        if (!initialised || (source.weight < .001 && !rest)) { source.x = plane.x; source.y = plane.y; source.z = plane.z; }
        source.x = approach(source.x, plane.x, dt, .06); source.y = approach(source.y, plane.y, dt, .06); source.z = approach(source.z, plane.z, dt, .06);
        source.weight = approach(source.weight, 1, dt, .25);
        source.open = approach(source.open, clamp01(hand.openness), dt, .12);
      } else {
        source.weight = approach(source.weight, 0, dt, rest ? 1.6 : .8);
        source.open = approach(source.open, IDLE_OPENNESS, dt, .5);
        if (rest) { source.x = approach(source.x, idle.x, dt, 1.2); source.z = approach(source.z, idle.z, dt, 1.2); source.y = approach(source.y, IDLE_HEIGHT, dt, 1.2); }
      }
      settle(source, radius, twin);
      aimTarget(source, twin, aim);
      if (!initialised) { source.aimX = aim.x; source.aimZ = aim.z; }
      source.aimX = approach(source.aimX, aim.x, dt, .4); source.aimZ = approach(source.aimZ, aim.z, dt, .4);
    }

    function stepSignals(dt: number) {
      const k = .15;
      smooth.spread = approach(smooth.spread, raw.spread, dt, k);
      smooth.brightness = approach(smooth.brightness, raw.brightness, dt, k);
      smooth.reflected = approach(smooth.reflected, raw.reflected, dt, k);
      smooth.incidence = approach(smooth.incidence, raw.incidence, dt, k);
      smooth.inside = approach(smooth.inside, raw.inside, dt, k);
      smooth.hue = approach(smooth.hue, raw.hue, dt, k);
      smooth.occluded = approach(smooth.occluded, raw.occluded, dt, k);
      smooth.elevation = approach(smooth.elevation, primary.y, dt, k);
      for (const key of Object.keys(smooth) as (keyof typeof smooth)[]) smooth[key] = clamp01(smooth[key]);
    }

    function initialise(twin: boolean) {
      placePrisms(twin);
      idleOrbit(orbit, 0, aspect, depth, idle);
      primary.x = idle.x; primary.z = idle.z; primary.y = IDLE_HEIGHT;
      primary.aimX = second.aimX = centreA.x; primary.aimZ = second.aimZ = centreA.z;
      second.x = idle.x; second.z = idle.z;
    }

    return {
      step(input: SimInput, params) {
        const dt = input.dt;
        time = input.time; presence = input.presence; hands = input.hands; surface = input.surface;
        rotation += params.spin * dt;
        if (rotation > TAU) rotation -= TAU; else if (rotation < 0) rotation += TAU;
        placePrisms(params.twin);
        // Idle beam: a slow orbit around the prism in the light plane, breathing a little so the incidence keeps changing.
        orbit += dt * (TAU / 48) * (1 - .6 * presence);
        idleOrbit(orbit, time, aspect, depth, idle);
        const radius = prismRadius(params.size, aspect, depth);
        const first = input.primary;
        const other = input.hands.length > 1 ? input.hands.find(h => h !== first) ?? null : null;
        if (!initialised) initialise(params.twin);
        updateSource(primary, first, dt, radius, params.twin, true);
        updateSource(second, other, dt, radius, params.twin, false);
        initialised = true;
        stepSignals(dt);
        dirty = true;
      },
      render(frame, params) {
        if (frame.width !== width || frame.height !== height) { width = frame.width; height = frame.height; allocate(); dirty = true; }
        if (frame.aspect !== aspect) { aspect = frame.aspect; camera = prismCamera(aspect, depth); placePrisms(params.twin); dirty = true; }
        if (!initialised) initialise(params.twin);
        if (dirty) { traceScene(params); dirty = false; }
        if (!scene || !half || !quarterA || !quarterB || !wide) return;

        // 1. Spectral beams, their deposits and ghost solids in the light buffer.
        scene.clear(0, 0, 0, 1);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        // The scan is the solid when present; the skeleton ghost only draws without one.
        const scanReady = surfaceTexture.upload(surface);
        packHands(scanReady ? [] : hands, aspect, depth, packed);
        if (scanReady && surface) scanBounds(surface);
        if (scanReady || packed.count > 0) {
          ghost.use().f1('u_aspect', aspect).f1('u_depth', depth).f1('u_eye', camera.eye).f1('u_eyeY', EYE_HEIGHT).f1('u_ghost', 1)
            .f3('u_color', GHOST.color[0], GHOST.color[1], GHOST.color[2]).f4('u_scanBox', scanBox[0], scanBox[1], scanBox[2], scanBox[3])
            .f3('u_scanZ', scanZ[0], scanZ[1], SCAN_THICKNESS * depth)
            .f4v('u_capsules', packed.capsules).i1('u_capsuleCount', packed.count).f4v('u_handBounds', packed.bounds).i1('u_handBoundCount', packed.boundCount)
            .texture('u_surface', surfaceTexture.texture, 0).i1('u_surfaceReady', scanReady ? 1 : 0)
            .f2('u_surfaceTexel', 1 / Math.max(1, surfaceTexture.width), 1 / Math.max(1, surfaceTexture.height)).f1('u_surfaceAspect', aspect).f1('u_surfaceDepth', depth);
          drawQuad(gl);
        }
        lineProgram.use().matrix4('u_matrix', camera.matrix).f1('u_eye', camera.eye).f2('u_viewport', scene.width, scene.height).f1('u_halfWidth', LINE.halfWidth)
          .f1('u_core', LINE.core).f1('u_halo', LINE.halo).f1('u_haloGain', LINE.haloGain);
        for (const slot of slots) {
          if (slot.count === 0) continue;
          gl.bindVertexArray(slot.vao);
          gl.vertexAttrib2f(2, slot.planeY, slot.planeY); lineProgram.f1('u_gain', 1); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, slot.count);
          if (params.floor > 0) { gl.vertexAttrib2f(2, 0, 0); lineProgram.f1('u_gain', FLOOR_LINE_GAIN * params.floor); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, slot.count); }
        }
        splashProgram.use().matrix4('u_matrix', camera.matrix).f2('u_volume', aspect, depth).f1('u_radius', SPLASH.radius).f1('u_gain', SPLASH.gain / (SPLASH.radius * scene.height));
        for (const slot of slots) {
          if (slot.count === 0) continue;
          gl.bindVertexArray(slot.vao); gl.vertexAttrib2f(2, slot.planeY, slot.planeY);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, slot.count);
        }
        if (slots[0].hitCount + slots[1].hitCount > 0) {
          skinProgram.use().matrix4('u_matrix', camera.matrix).f1('u_radius', SKIN_SPLASH.radius).f1('u_gain', SKIN_SPLASH.gain / (SKIN_SPLASH.radius * scene.height))
            .f3('u_tint', SKIN_SPLASH.tint[0], SKIN_SPLASH.tint[1], SKIN_SPLASH.tint[2]);
          for (const slot of slots) {
            if (slot.hitCount === 0) continue;
            gl.bindVertexArray(slot.hitVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, slot.hitCount);
          }
        }
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

        // 3. Analytic glass refraction, studio reflections, stone floor and filmic output.
        bindScreen(gl, frame.width, frame.height);
        composite.use().texture('u_scene', scene.texture, 0).texture('u_glow', quarterA.texture, 1).texture('u_wide', wide.texture, 2)
          .f1('u_aspect', aspect).f1('u_depth', depth).f1('u_eye', camera.eye).f1('u_eyeY', EYE_HEIGHT)
          .f1('u_glowGain', params.glow * .65).f1('u_wideGain', params.glow * .4)
          .f1('u_floor', params.floor).f4v('u_planes', glassPlanes).i1('u_polys', params.twin ? 2 : 1)
          .f1('u_height', params.height).f1('u_index', params.glass + params.dispersion * CAUCHY_B_GLASS / (.55 * .55))
          .f1('u_roughness', params.roughness);
        drawQuad(gl);
      },
      signals() { return smooth; },
      resize(w, h) { width = w; height = h; aspect = w / Math.max(1, h); camera = prismCamera(aspect, depth); allocate(); dirty = true; },
      dispose() {
        for (const f of [scene, half, quarterA, quarterB, wide]) f?.dispose();
        scene = half = quarterA = quarterB = wide = null;
        for (const slot of slots) { gl.deleteBuffer(slot.vbo); gl.deleteVertexArray(slot.vao); gl.deleteBuffer(slot.hitVbo); gl.deleteVertexArray(slot.hitVao); }
        lineProgram.dispose(); splashProgram.dispose(); skinProgram.dispose(); downsample.dispose(); blur.dispose(); composite.dispose(); ghost.dispose();
        surfaceTexture.dispose();
        if (global.prismDiagnostics === diagnostics) delete global.prismDiagnostics;
      },
    };
  },
});
