/**
 * Presence — the reference simulation.
 *
 * Black. When a hand is present a soft light gathers around it, breathes with
 * the hand's stillness, and tightens when the hand pushes in. This is the
 * smallest complete simulation: copy this folder to start a new idea.
 *
 * What every simulation must provide:
 *  - `params`: what an author or the audio side may change, with ranges.
 *  - `signals`: what the audio side may listen to, with ranges.
 *  - `create()`: builds GPU resources and returns step/render/signals/dispose.
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { approach, clamp01, hsv } from '../../core/math';
import { hexToRgb } from '../../core/params';
import { drawQuad, quadProgram } from '../../gl/quad';
import { bindScreen } from '../../gl/fbo';
import { GLSL_HEADER } from '../../gl/program';

const MAX_HANDS = 4;

const FRAGMENT = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform float u_aspect;
uniform int u_count;
uniform vec4 u_hands[${MAX_HANDS}];   // x, y, radius, intensity (sim space; radius in uniform units)
uniform vec3 u_color;
void main() {
  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y);
  vec3 light = vec3(0.0);
  for (int i = 0; i < ${MAX_HANDS}; i++) {
    if (i >= u_count) break;
    vec4 h = u_hands[i];
    vec2 c = vec2(h.x * u_aspect, h.y);
    float d = distance(p, c) / max(h.z, 1e-3);
    // Soft core plus a halo; the halo carries the colour, the core stays warm-white. Both are
    // Gaussian so the light reaches true black within a few radii instead of washing the frame.
    float core = exp(-d * d * 3.0);
    float halo = exp(-d * d * 0.45) * 0.4;
    light += h.w * (core * mix(u_color, vec3(1.0), 0.6) + halo * u_color);
  }
  // Filmic-ish roll-off so the core never clips to flat white, then sRGB-ish gamma.
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
  description: 'Black until a hand arrives; a soft light gathers around it and tightens when pushed. The reference simulation to copy.',
  params: {
    radius: { kind: 'number', default: .18, min: .04, max: .6, step: .01, label: 'Light radius', description: 'Radius of the light in uniform units (canvas height = 1).' },
    breathe: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Breathing', description: 'How much the light pulses while the hand holds still.' },
    hueDrift: { kind: 'number', default: .003, min: 0, max: .2, step: .001, unit: 'cycles/s', label: 'Hue drift', description: 'Slow rotation of the hue around the base colour.' },
    color: { kind: 'color', default: '#ffa050', label: 'Base colour', description: 'Colour of the halo before hue drift is applied.' },
    fade: { kind: 'number', default: 1.2, min: .05, max: 6, step: .05, unit: 's', label: 'Fade time', description: 'How long the light lingers after the hand leaves.' },
  },
  signals: {
    presence: { min: 0, max: 1, description: 'Smoothed hand presence from the tracker.' },
    brightness: { min: 0, max: 1, description: 'Total light currently on screen, normalised.' },
    x: { min: 0, max: 1, description: 'Primary hand x in sim space (last known).' },
    y: { min: 0, max: 1, description: 'Primary hand y in sim space (last known).' },
    push: { min: 0, max: 1, description: 'Primary hand depth push.' },
    hue: { min: 0, max: 1, description: 'Current hue of the light (base colour plus drift).' },
  },
  create(ctx) {
    const gl = ctx.gl;
    const program = quadProgram(gl, FRAGMENT, 'presence');
    const lights: { x: number; y: number; intensity: number; radius: number; id: number }[] = [];
    let time = 0, drift = 0, hue = 0, presence = 0, push = 0, brightness = 0, lastX = .5, lastY = .5;
    const uniforms = new Float32Array(MAX_HANDS * 4);

    return {
      step(input: SimInput, params) {
        time = input.time; presence = input.presence;
        drift = (drift + params.hueDrift * input.dt) % 1;
        // Keep a light per hand; lights of departed hands fade out instead of vanishing.
        for (const hand of input.hands) {
          let light = lights.find(l => l.id === hand.id);
          if (!light) { light = { id: hand.id, x: hand.position.x, y: hand.position.y, intensity: 0, radius: params.radius }; lights.push(light); }
          light.x = hand.position.x; light.y = hand.position.y;
          const stillness = 1 - clamp01(hand.speed / .6);
          const breathing = 1 + params.breathe * .35 * Math.sin(time * 2.2) * stillness;
          const target = (.55 + .45 * hand.push) * breathing;
          light.intensity = approach(light.intensity, target, input.dt, .12);
          light.radius = approach(light.radius, params.radius * (1 - .45 * hand.push) * (1 + .4 * hand.radius / .06), input.dt, .15);
        }
        for (let i = lights.length - 1; i >= 0; i--) {
          const l = lights[i];
          if (!input.hands.some(h => h.id === l.id)) { l.intensity = approach(l.intensity, 0, input.dt, params.fade / 3); if (l.intensity < .005) lights.splice(i, 1); }
        }
        if (input.primary) { lastX = input.primary.position.x; lastY = input.primary.position.y; push = input.primary.push; } else push = approach(push, 0, input.dt, .3);
        brightness = clamp01(lights.reduce((s, l) => s + l.intensity, 0) / 1.5);
      },
      render(frame, params) {
        // Rotate the base colour's hue by the drift; saturation and value stay as authored.
        const [baseHue, saturation, value] = rgbToHsv(...hexToRgb(params.color));
        hue = (baseHue + drift) % 1;
        const [r, g, b] = hsv(hue, saturation, value);
        const count = Math.min(MAX_HANDS, lights.length);
        for (let i = 0; i < count; i++) { const l = lights[i]; uniforms.set([l.x, l.y, l.radius, l.intensity], i * 4); }
        bindScreen(gl, frame.width, frame.height);
        program.use().f1('u_aspect', frame.aspect).i1('u_count', count).f4v('u_hands', uniforms).f3('u_color', r, g, b);
        drawQuad(gl);
      },
      signals() { return { presence, brightness, x: lastX, y: lastY, push, hue }; },
      dispose() { program.dispose(); },
    };
  },
});
