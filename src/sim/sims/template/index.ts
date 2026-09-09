/**
 * Presence — the reference simulation.
 *
 * Black. When a hand is present a soft light gathers around it, breathes with
 * the hand's stillness, and moves through the volume with it: nearer the glass
 * it is large and warm, deeper in it is smaller, dimmer and a touch cooler, and
 * a faint floor grid fades in beneath it so the depth can be read. This is the
 * smallest complete 3D simulation: copy this folder to start a new idea.
 *
 * What every simulation must provide:
 *  - `params`: what an author or the audio side may change, with ranges.
 *  - `signals`: what the audio side may listen to, with ranges.
 *  - `create()`: builds GPU resources and returns step/render/signals/dispose.
 *
 * How it uses the volume: hands arrive in sim space [0,1]³; `toWorld` turns
 * that into uniform units and `windowCamera` projects world points to the
 * screen with perspective. The floor grid is the same camera run backwards in
 * the shader (a ray from the eye through each pixel, intersected with y = 0).
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { approach, clamp01, hsv } from '../../core/math';
import { toWorld, windowCamera } from '../../core/camera';
import { hexToRgb } from '../../core/params';
import { drawQuad, quadProgram } from '../../gl/quad';
import { bindScreen } from '../../gl/fbo';
import { GLSL_HEADER } from '../../gl/program';

const MAX_HANDS = 4;

const FRAGMENT = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform float u_aspect, u_depth, u_eye;
uniform int u_count;
uniform vec4 u_lights[${MAX_HANDS}];   // ndc x, ndc y, radius in uniform units at the glass, intensity
uniform vec4 u_lightMeta[${MAX_HANDS}]; // perspective scale, depth 0..1, unused, unused
uniform vec3 u_color;
uniform float u_floor;

void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  // Uniform-unit position on the glass for this pixel, so distances are round.
  vec2 p = vec2(ndc.x * u_aspect * 0.5, ndc.y * 0.5);
  vec3 light = vec3(0.0);
  for (int i = 0; i < ${MAX_HANDS}; i++) {
    if (i >= u_count) break;
    vec4 l = u_lights[i]; vec4 m = u_lightMeta[i];
    vec2 c = vec2(l.x * u_aspect * 0.5, l.y * 0.5);
    float r = max(l.z * m.x, 1e-3);            // apparent radius shrinks with depth
    float d = distance(p, c) / r;
    float core = exp(-d * d * 3.0);
    float halo = exp(-d * d * 0.45) * 0.4;
    // Aerial perspective: deeper lights are dimmer and a little cooler.
    vec3 tint = mix(u_color, u_color * vec3(0.7, 0.85, 1.1), m.y * 0.6);
    float atten = 1.0 / (1.0 + 1.2 * m.y);
    light += l.w * atten * (core * mix(tint, vec3(1.0), 0.6) + halo * tint);
  }
  // Floor grid at y = 0: cast the pixel's ray from the eye through the glass and intersect the floor.
  if (ndc.y < -0.001 && u_floor > 0.0) {
    float t = -0.5 / (ndc.y * 0.5);               // eye height 0.5 above the floor
    float x = u_aspect * 0.5 + t * ndc.x * u_aspect * 0.5;
    float z = -u_eye + t * u_eye;
    if (z >= 0.0 && z <= u_depth && x >= 0.0 && x <= u_aspect) {
      float gx = abs(fract(x * 6.0) - 0.5), gz = abs(fract(z * 6.0) - 0.5);
      float line = 1.0 - smoothstep(0.47, 0.5, max(gx, gz));   // thin lines, softened at the far end by the fade
      float fade = (1.0 - z / u_depth) * 0.08 * u_floor;
      light += u_color * line * fade;
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
  description: 'Black until a hand arrives; a soft light gathers around it and travels with it through the volume, over a faint floor. The reference simulation to copy.',
  params: {
    radius: { kind: 'number', default: .16, min: .04, max: .6, step: .01, label: 'Light radius', description: 'Radius of the light at the glass, in uniform units (canvas height = 1).' },
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
    hue: { min: 0, max: 1, description: 'Current hue of the light (base colour plus drift).' },
  },
  create(ctx) {
    const gl = ctx.gl;
    const program = quadProgram(gl, FRAGMENT, 'presence');
    interface Light { id: number; x: number; y: number; z: number; intensity: number; radius: number }
    const lights: Light[] = [];
    let time = 0, drift = 0, hue = 0, presence = 0, brightness = 0, lastX = .5, lastY = .5, lastZ = .5;
    const lightData = new Float32Array(MAX_HANDS * 4), metaData = new Float32Array(MAX_HANDS * 4);

    return {
      step(input: SimInput, params) {
        time = input.time; presence = input.presence;
        drift = (drift + params.hueDrift * input.dt) % 1;
        // Keep a light per hand; lights of departed hands fade out instead of vanishing.
        for (const hand of input.hands) {
          let light = lights.find(l => l.id === hand.id);
          if (!light) { light = { id: hand.id, x: hand.position.x, y: hand.position.y, z: hand.position.z, intensity: 0, radius: params.radius }; lights.push(light); }
          light.x = hand.position.x; light.y = hand.position.y; light.z = hand.position.z;
          const stillness = 1 - clamp01(hand.speed / .6);
          const breathing = 1 + params.breathe * .35 * Math.sin(time * 2.2) * stillness;
          light.intensity = approach(light.intensity, .8 * breathing, input.dt, .12);
          // Bigger hands get a bigger light, within reason: sources that report fingertips (Leap) have wide extents.
          light.radius = approach(light.radius, params.radius * (1 + .4 * Math.min(hand.radius, .12) / .06), input.dt, .15);
        }
        for (let i = lights.length - 1; i >= 0; i--) {
          const l = lights[i];
          if (!input.hands.some(h => h.id === l.id)) { l.intensity = approach(l.intensity, 0, input.dt, params.fade / 3); if (l.intensity < .005) lights.splice(i, 1); }
        }
        if (input.primary) { lastX = input.primary.position.x; lastY = input.primary.position.y; lastZ = input.primary.position.z; }
        brightness = clamp01(lights.reduce((s, l) => s + l.intensity / (1 + 1.2 * l.z), 0) / 1.5);
      },
      render(frame, params) {
        const [baseHue, saturation, value] = rgbToHsv(...hexToRgb(params.color));
        hue = (baseHue + drift) % 1;
        const [r, g, b] = hsv(hue, saturation, value);
        const camera = windowCamera(frame.aspect, frame.depth);
        const count = Math.min(MAX_HANDS, lights.length);
        for (let i = 0; i < count; i++) {
          const l = lights[i];
          const p = camera.project(toWorld({ x: l.x, y: l.y, z: l.z }, frame.aspect, frame.depth));
          lightData.set([p.x, p.y, l.radius, l.intensity], i * 4);
          metaData.set([p.scale, l.z, 0, 0], i * 4);
        }
        bindScreen(gl, frame.width, frame.height);
        program.use().f1('u_aspect', frame.aspect).f1('u_depth', frame.depth).f1('u_eye', camera.eye).i1('u_count', count)
          .f4v('u_lights', lightData).f4v('u_lightMeta', metaData).f3('u_color', r, g, b).f1('u_floor', params.floor * presence);
        drawQuad(gl);
      },
      signals() { return { presence, brightness, x: lastX, y: lastY, z: lastZ, hue }; },
      dispose() { program.dispose(); },
    };
  },
});
