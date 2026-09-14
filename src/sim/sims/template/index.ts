/**
 * Presence — the reference simulation.
 *
 * Black. When a hand is present it appears as a ghostly solid in the volume,
 * lit from within: finger bones, palm and forearm when the source knows the
 * skeleton (Leap), a soft sphere otherwise. A warm light gathers around it,
 * breathes with the hand's stillness, and a faint floor grid fades in beneath
 * so the depth can be read. This is the smallest complete 3D simulation:
 * copy this folder to start a new idea.
 *
 * What every simulation must provide:
 *  - `params`: what an author or the audio side may change, with ranges.
 *  - `signals`: what the audio side may listen to, with ranges.
 *  - `create()`: builds GPU resources and returns step/render/signals/dispose.
 *
 * How it uses the volume: hands arrive in sim space [0,1]³ with a solid shape
 * (`capsules`); `packHands` turns them into world-unit capsules for the GPU and
 * `handSdfGlsl` gives the shader a distance field. The ghost is ray-marched
 * through that field only where a ray hits a hand's bounding sphere, so the
 * cost stays with the hand, not the screen. The floor grid is the window
 * camera run backwards (a ray from the eye through each pixel, hitting y = 0).
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { approach, clamp01, hsv } from '../../core/math';
import { toWorld, windowCamera } from '../../core/camera';
import { hexToRgb } from '../../core/params';
import { createPackedHands, handSdfGlsl, packHands } from '../../gl/hand';
import { SurfaceTexture, surfaceGlsl } from '../../gl/surface';
import { drawQuad, quadProgram } from '../../gl/quad';
import { bindScreen } from '../../gl/fbo';
import { GLSL_HEADER } from '../../gl/program';

const MAX_LIGHTS = 4;

const FRAGMENT = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform float u_aspect, u_depth, u_eye, u_ghost, u_floor, u_time;
uniform int u_count;
uniform vec4 u_lights[${MAX_LIGHTS}];    // ndc x, ndc y, radius at the glass, intensity
uniform vec4 u_lightMeta[${MAX_LIGHTS}]; // perspective scale, depth 0..1, unused, unused
uniform vec3 u_color;
${handSdfGlsl()}
${surfaceGlsl()}

// Rim-lit translucent skin shared by the scan and the capsule ghost.
vec3 ghostSkin(vec3 n, vec3 rd, float depth01, float wave) {
  float rim = pow(1.0 - abs(dot(n, -rd)), 2.5);
  float breathe = 0.85 + 0.15 * sin(u_time * 1.7 + wave);
  vec3 skin = mix(u_color, vec3(1.0), 0.35) * (0.10 + 0.9 * rim) * breathe;
  vec3 inner = u_color * 0.08 * (1.0 + 0.5 * n.y);
  return (skin + inner) / (1.0 + 0.9 * depth01);
}

vec3 handNormal(vec3 p) {
  vec2 e = vec2(0.004, 0.0);
  return normalize(vec3(handDistance(p + e.xyy) - handDistance(p - e.xyy), handDistance(p + e.yxy) - handDistance(p - e.yxy), handDistance(p + e.yyx) - handDistance(p - e.yyx)));
}

void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  vec2 p = vec2(ndc.x * u_aspect * 0.5, ndc.y * 0.5);
  vec3 light = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= u_count) break;
    vec4 l = u_lights[i]; vec4 m = u_lightMeta[i];
    vec2 c = vec2(l.x * u_aspect * 0.5, l.y * 0.5);
    float r = max(l.z * m.x, 1e-3);
    float d = distance(p, c) / r;
    float core = exp(-d * d * 3.0);
    float halo = exp(-d * d * 0.45) * 0.4;
    vec3 tint = mix(u_color, u_color * vec3(0.7, 0.85, 1.1), m.y * 0.6);
    float atten = 1.0 / (1.0 + 1.2 * m.y);
    light += l.w * atten * (core * mix(tint, vec3(1.0), 0.6) + halo * tint);
  }

  // The window camera, backwards: a ray from the eye through this pixel on the glass.
  vec3 ro = vec3(u_aspect * 0.5, 0.5, -u_eye);
  vec3 rd = normalize(vec3(ndc.x * u_aspect * 0.5, ndc.y * 0.5, u_eye));

  // Floor grid at y = 0.
  if (rd.y < -0.001 && u_floor > 0.0) {
    float t = -ro.y / rd.y;
    vec3 f = ro + rd * t;
    if (f.z >= 0.0 && f.z <= u_depth && f.x >= 0.0 && f.x <= u_aspect) {
      float gx = abs(fract(f.x * 6.0) - 0.5), gz = abs(fract(f.z * 6.0) - 0.5);
      float line = 1.0 - smoothstep(0.47, 0.5, max(gx, gz));
      float fade = (1.0 - f.z / u_depth) * 0.08 * u_floor;
      // The hand's shadow on the floor: darker where a hand is directly above (capsules), or where the scan covers the column (surface).
      float shade = 1.0 - 0.7 * u_ghost * clamp(1.0 - handDistance(vec3(f.x, f.y + 0.02, f.z)) * 4.0, 0.0, 1.0) * float(u_capsuleCount > 0);
      if (u_surfaceReady == 1) {
        // The scan is a front shell over (x, y); its shadow falls where the column above the floor point is scanned around that depth.
        float m = 0.0;
        for (int k = 0; k < 6; k++) { vec2 xy = vec2(f.x / u_aspect, (0.05 + 0.15 * float(k))); float zs = surfaceDepth(xy) * u_depth; m = max(m, surfaceMask(xy) * exp(-abs(zs - f.z) * 6.0)); }
        shade *= 1.0 - 0.6 * u_ghost * m;
      }
      light += u_color * line * fade * shade;
    }
  }

  // The scanned surface (depth camera): march the ray until it passes behind the shell.
  if (u_surfaceReady == 1 && u_ghost > 0.0) {
    vec4 hit = surfaceHit(ro, rd, u_depth, 48);
    if (hit.w > 0.0) {
      vec3 n = surfaceNormal(vec2(hit.x / u_aspect, hit.y));
      light = light * 0.35 + ghostSkin(n, rd, clamp(hit.z / u_depth, 0.0, 1.0), hit.y * 6.0) * u_ghost;
    }
  }

  // The ghost hand: sphere-trace the capsule field, but only along the part of the ray inside a hand's bounds.
  if (u_capsuleCount > 0 && u_ghost > 0.0) {
    vec2 span = handBoundsHit(ro, rd);
    if (span.y > max(span.x, 0.0)) {
      float t = max(span.x, 0.0), tEnd = span.y;
      float hit = -1.0;
      for (int i = 0; i < 40; i++) {
        vec3 q = ro + rd * t;
        float d = handDistance(q);
        if (d < 0.0015) { hit = t; break; }
        t += max(d, 0.002);
        if (t > tEnd) break;
      }
      if (hit > 0.0) {
        vec3 q = ro + rd * hit;
        light = light * 0.35 + ghostSkin(handNormal(q), rd, clamp(q.z / u_depth, 0.0, 1.0), q.y * 6.0) * u_ghost;
      }
    }
  }

  light = light / (1.0 + light);
  o = vec4(pow(light, vec3(1.0 / 2.2)), 1.0);
}`;

/** rgb 0..1 → hue 0..1, saturation, value. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-6) h = max === r ? ((g - b) / d + 6) % 6 / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, max > 1e-6 ? d / max : 0, max];
}

export default defineSimulation({
  id: 'presence',
  title: 'Presence',
  description: 'Black until a hand arrives; it appears as a ghostly solid in the volume with a soft light around it, over a faint floor. The reference simulation to copy.',
  params: {
    radius: { kind: 'number', default: .16, min: .04, max: .6, step: .01, label: 'Light radius', description: 'Radius of the light at the glass, in uniform units (canvas height = 1).' },
    ghost: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Ghost hand', description: 'Brightness of the translucent hand: the depth-camera scan when there is one, else the skeleton, else nothing.' },
    breathe: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Breathing', description: 'How much the light pulses while the hand holds still.' },
    hueDrift: { kind: 'number', default: .003, min: 0, max: .2, step: .001, unit: 'cycles/s', label: 'Hue drift', description: 'Slow rotation of the hue around the base colour.' },
    color: { kind: 'color', default: '#ffa050', label: 'Base colour', description: 'Colour of the halo before hue drift is applied.' },
    fade: { kind: 'number', default: 1.2, min: .05, max: 6, step: .05, unit: 's', label: 'Fade time', description: 'How long the light lingers after the hand leaves.' },
    floor: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Floor grid', description: 'Brightness of the depth-cue grid on the floor of the volume while a hand is present.' },
  },
  signals: {
    presence: { min: 0, max: 1, description: 'Smoothed hand presence from the tracker.' },
    brightness: { min: 0, max: 1, description: 'Total light currently on screen, normalised.' },
    x: { min: 0, max: 1, description: 'Primary hand x in sim space (last known).' },
    y: { min: 0, max: 1, description: 'Primary hand y in sim space (last known).' },
    z: { min: 0, max: 1, description: 'Primary hand depth in sim space: 0 at the glass, 1 at the back wall (last known).' },
    solid: { min: 0, max: 1, description: '1 while the source supplies a solid shape (a depth scan or a skeleton), 0 for a bare position.' },
    scanned: { min: 0, max: 1, description: 'Fraction of the front face covered by the depth-camera scan (0 without a scan).' },
    hue: { min: 0, max: 1, description: 'Current hue of the light (base colour plus drift).' },
  },
  create(ctx) {
    const gl = ctx.gl;
    const program = quadProgram(gl, FRAGMENT, 'presence');
    interface Light { id: number; x: number; y: number; z: number; intensity: number; radius: number }
    const lights: Light[] = [];
    const packed = createPackedHands();
    const surfaceTexture = new SurfaceTexture(gl);
    let time = 0, drift = 0, hue = 0, presence = 0, brightness = 0, solid = 0, scanned = 0, lastX = .5, lastY = .5, lastZ = .5;
    let hands: SimInput['hands'] = [];
    let surface: SimInput['surface'] = null;
    const lightData = new Float32Array(MAX_LIGHTS * 4), metaData = new Float32Array(MAX_LIGHTS * 4);

    return {
      step(input: SimInput, params) {
        time = input.time; presence = input.presence; hands = input.hands; surface = input.surface;
        if (surface) { let n = 0; for (let i = 0; i < surface.mask.length; i++) if (surface.mask[i]) n++; scanned = approach(scanned, n / surface.mask.length, input.dt, .1); }
        else scanned = approach(scanned, 0, input.dt, .2);
        drift = (drift + params.hueDrift * input.dt) % 1;
        for (const hand of input.hands) {
          let light = lights.find(l => l.id === hand.id);
          if (!light) { light = { id: hand.id, x: hand.position.x, y: hand.position.y, z: hand.position.z, intensity: 0, radius: params.radius }; lights.push(light); }
          light.x = hand.position.x; light.y = hand.position.y; light.z = hand.position.z;
          const stillness = 1 - clamp01(hand.speed / .6);
          const breathing = 1 + params.breathe * .35 * Math.sin(time * 2.2) * stillness;
          light.intensity = approach(light.intensity, .8 * breathing, input.dt, .12);
          light.radius = approach(light.radius, params.radius * (1 + .4 * Math.min(hand.radius, .12) / .06), input.dt, .15);
        }
        for (let i = lights.length - 1; i >= 0; i--) {
          const l = lights[i];
          if (!input.hands.some(h => h.id === l.id)) { l.intensity = approach(l.intensity, 0, input.dt, params.fade / 3); if (l.intensity < .005) lights.splice(i, 1); }
        }
        if (input.primary) { lastX = input.primary.position.x; lastY = input.primary.position.y; lastZ = input.primary.position.z; }
        solid = approach(solid, input.surface || input.primary?.capsules.length ? 1 : 0, input.dt, .1);
        brightness = clamp01(lights.reduce((s, l) => s + l.intensity / (1 + 1.2 * l.z), 0) / 1.5);
      },
      render(frame, params) {
        const [baseHue, saturation, value] = rgbToHsv(...hexToRgb(params.color));
        hue = (baseHue + drift) % 1;
        const [r, g, b] = hsv(hue, saturation, value);
        const camera = windowCamera(frame.aspect, frame.depth);
        const count = Math.min(MAX_LIGHTS, lights.length);
        for (let i = 0; i < count; i++) {
          const l = lights[i];
          const p = camera.project(toWorld({ x: l.x, y: l.y, z: l.z }, frame.aspect, frame.depth));
          lightData.set([p.x, p.y, l.radius, l.intensity], i * 4);
          metaData.set([p.scale, l.z, 0, 0], i * 4);
        }
        // The scan is the primary solid when present; the skeleton ghost only draws without one.
        const scanReady = surfaceTexture.upload(surface);
        packHands(scanReady ? [] : hands, frame.aspect, frame.depth, packed);
        bindScreen(gl, frame.width, frame.height);
        program.use().f1('u_aspect', frame.aspect).f1('u_depth', frame.depth).f1('u_eye', camera.eye).f1('u_time', frame.time).i1('u_count', count)
          .f4v('u_lights', lightData).f4v('u_lightMeta', metaData).f3('u_color', r, g, b).f1('u_floor', params.floor * presence).f1('u_ghost', params.ghost)
          .f4v('u_capsules', packed.capsules).i1('u_capsuleCount', packed.count).f4v('u_handBounds', packed.bounds).i1('u_handBoundCount', packed.boundCount)
          .texture('u_surface', surfaceTexture.texture, 0).i1('u_surfaceReady', scanReady ? 1 : 0)
          .f2('u_surfaceTexel', 1 / Math.max(1, surfaceTexture.width), 1 / Math.max(1, surfaceTexture.height)).f1('u_surfaceAspect', frame.aspect).f1('u_surfaceDepth', frame.depth);
        drawQuad(gl);
      },
      signals() { return { presence, brightness, x: lastX, y: lastY, z: lastZ, solid, scanned, hue }; },
      dispose() { program.dispose(); surfaceTexture.dispose(); },
    };
  },
});
