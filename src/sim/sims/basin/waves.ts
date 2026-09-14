import type { Quality } from '../../core/types';
import { GLSL_HEADER } from '../../gl/program';

/** Damped wave equation, separate from the incompressible ink flow. The CFL
 * number c·dt/dx must stay below 1/√2. At 60 Hz even high is only 0.587.
 * One small pass per fixed step, with reflecting walls and no readbacks.
 */
export const WAVE_GRID: Record<Quality, number> = { low: 96, medium: 128, high: 160 };
export const WAVE_SPEED = .22;
export const WAVE_HEIGHT = .025;
export const WAVE_VELOCITY = .3;
export const WAVE_DAMPING = 1.6;

/** Two signed 16-bit values in RGBA8, including an exact representation of
 * zero. Decoding is linear, so hardware bilinear filtering remains valid.
 * The same storage works on float-capable and fallback devices.
 */
export const WAVE_STORAGE_GLSL = `
vec2 waveEncode(float x, float range) {
  float q = floor(clamp(x / range, -1.0, 1.0) * 32767.0 + 32768.5);
  return vec2(floor(q / 256.0), mod(q, 256.0)) / 255.0;
}
float waveDecode(vec2 bytes, float range) {
  return (dot(bytes, vec2(65280.0, 255.0)) - 32768.0) * (range / 32767.0);
}
float waveHeight(sampler2D field, vec2 uv) { return waveDecode(texture(field, uv).rg, ${WAVE_HEIGHT}); }
`;

export const WAVE_FS = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_wave;
uniform vec2 u_texel;
uniform float u_dt, u_bowl;
uniform int u_forceCount;
// centre, radius, velocity impulse. CPU caps the set at eight, including scan wakes.
uniform vec4 u_forces[8];
${WAVE_STORAGE_GLSL}
float neighbour(vec2 uv, float centre) {
  return length(uv - 0.5) < u_bowl ? waveHeight(u_wave, uv) : centre;
}
void main() {
  float h = waveHeight(u_wave, v_uv);
  float v = waveDecode(texture(u_wave, v_uv).ba, ${WAVE_VELOCITY});
  if (length(v_uv - 0.5) >= u_bowl) { o = vec4(waveEncode(0.0, 1.0), waveEncode(0.0, 1.0)); return; }
  float lap = neighbour(v_uv + vec2(u_texel.x, 0), h) + neighbour(v_uv - vec2(u_texel.x, 0), h)
            + neighbour(v_uv + vec2(0, u_texel.y), h) + neighbour(v_uv - vec2(0, u_texel.y), h) - 4.0 * h;
  v = (v + ${WAVE_SPEED * WAVE_SPEED} * u_dt * lap / (u_texel.x * u_texel.x)) * exp(-${WAVE_DAMPING} * u_dt);
  for (int i = 0; i < 8; i++) {
    if (i >= u_forceCount) break;
    vec4 f = u_forces[i]; vec2 q = (v_uv - f.xy) / f.z;
    float r2 = dot(q, q);
    // A zero-mean dip and raised ring displace water without filling the bowl.
    v += f.w * (1.0 - r2) * exp(-r2);
  }
  v = clamp(v, -${WAVE_VELOCITY}, ${WAVE_VELOCITY});
  h = clamp((h + v * u_dt) * exp(-0.12 * u_dt), -${WAVE_HEIGHT}, ${WAVE_HEIGHT});
  o = vec4(waveEncode(h, ${WAVE_HEIGHT}), waveEncode(v, ${WAVE_VELOCITY}));
}`;
