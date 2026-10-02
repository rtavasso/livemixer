/**
 * Tide's shaders: the wave pass (damped wave equation on a packed height/rate field), the plankton
 * glow pass (light from wave motion, with afterglow), the composite (glow on true black inside the
 * ghost frame) and the eel points.
 *
 * The wave field is packed into RGBA8 as two signed 16-bit values (Basin's storage), so the
 * same field works whether or not the device renders to float targets; the glow buffer is RGBA16F
 * where available, RGBA8 otherwise (its decay has a small linear floor so 8-bit values still reach 0).
 */
import { GLSL_HEADER } from '../../gl/program';
import { ghostFrameGlsl } from '../living';
import { HEIGHT_RANGE, MAX_FORCES, RATE_RANGE } from './model';

const f = (x: number) => x.toFixed(6);

const STORAGE = `
vec2 waveEncode(float x, float range) {
  float q = floor(clamp(x / range, -1.0, 1.0) * 32767.0 + 32768.5);
  return vec2(floor(q / 256.0), mod(q, 256.0)) / 255.0;
}
float waveDecode(vec2 bytes, float range) { return (dot(bytes, vec2(65280.0, 255.0)) - 32768.0) * (range / 32767.0); }
float heightAt(sampler2D w, vec2 uv) { return waveDecode(texture(w, uv).rg, ${f(HEIGHT_RANGE)}); }
float rateAt(sampler2D w, vec2 uv) { return waveDecode(texture(w, uv).ba, ${f(RATE_RANGE)}); }
`;

/** The rest state of the packed field (height 0, rate 0) as a clear colour. */
export const REST: [number, number, number, number] = [128 / 255, 0, 128 / 255, 0];

export const WAVE = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_wave;
uniform vec2 u_texel;
uniform float u_dx, u_dt, u_c2, u_damp, u_aspect;
uniform int u_count;
uniform vec4 u_forces[${MAX_FORCES}];
${STORAGE}
void main() {
  float h = heightAt(u_wave, v_uv), v = rateAt(u_wave, v_uv);
  float lap = heightAt(u_wave, v_uv + vec2(u_texel.x, 0.0)) + heightAt(u_wave, v_uv - vec2(u_texel.x, 0.0))
            + heightAt(u_wave, v_uv + vec2(0.0, u_texel.y)) + heightAt(u_wave, v_uv - vec2(0.0, u_texel.y)) - 4.0 * h;
  // An absorbing band at the picture's edges: waves run out into the dark instead of reflecting.
  vec2 e = min(v_uv, 1.0 - v_uv) * vec2(u_aspect, 1.0);
  float sponge = 1.0 - smoothstep(0.0, 0.07, min(e.x, e.y));
  v += u_c2 * u_dt * lap / (u_dx * u_dx);
  v *= exp(-(u_damp + 7.0 * sponge) * u_dt);
  for (int i = 0; i < ${MAX_FORCES}; i++) {
    if (i >= u_count) break;
    vec4 fo = u_forces[i];
    vec2 q = (v_uv - fo.xy) * vec2(u_aspect, 1.0) / fo.z;
    float r2 = dot(q, q);
    v += fo.w * (1.0 - r2) * exp(-r2);
  }
  v = clamp(v, -${f(RATE_RANGE)}, ${f(RATE_RANGE)});
  h = clamp((h + v * u_dt) * exp(-(0.08 + 3.0 * sponge) * u_dt), -${f(HEIGHT_RANGE)}, ${f(HEIGHT_RANGE)});
  o = vec4(waveEncode(h, ${f(HEIGHT_RANGE)}), waveEncode(v, ${f(RATE_RANGE)}));
}`;

/**
 * Plankton: r = surface glow, g = deep glow (where a hand reaches far through), b = eel wakes.
 * Emission is wave motion (|rate| and slope) above a small threshold, saturating toward 1, plus a
 * soft bloom where a hand touches and a sparse idle twinkle. Everything decays with the persistence.
 * A palm turned up (`u_offer`) wells the bloom brighter and wider; a palm turned down (`u_calm`)
 * damps it and lets the light under the hand fade faster (`handBloom` in model.ts mirrors the bloom).
 */
export const GLOW = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_glow, u_wave;
uniform vec2 u_waveTexel, u_glowSize;
uniform float u_decay, u_floor, u_gain, u_dt, u_aspect, u_time, u_sparkle;
uniform int u_handCount;
uniform vec4 u_hands[2];   // x, y (uv), radius (uniform units), reach
uniform float u_contact[2];
uniform float u_offer[2], u_calm[2];  // smoothed palm up / palm down, 0..1
uniform float u_offering, u_calming;  // gesture strengths
${STORAGE}
float hash(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(vec3(i, 7.0)), hash(vec3(i + vec2(1, 0), 7.0)), f.x), mix(hash(vec3(i + vec2(0, 1), 7.0)), hash(vec3(i + vec2(1, 1), 7.0)), f.x), f.y);
}
// Plankton is not uniform: bright specks in drifting clouds, so light comes out granular rather than as fog.
float plankton(vec2 uv) {
  vec2 drift = vec2(0.0, u_time * 0.004);
  float speck = hash(vec3(floor((uv + drift) * u_glowSize), 3.0));
  float cloud = vnoise((uv + drift) * vec2(u_aspect, 1.0) * 14.0);
  return 0.4 + 0.5 * cloud * cloud + 0.9 * speck * speck * speck;
}
void main() {
  vec3 g = texture(u_glow, v_uv).rgb;
  float v = rateAt(u_wave, v_uv);
  float gx = heightAt(u_wave, v_uv + vec2(u_waveTexel.x, 0.0)) - heightAt(u_wave, v_uv - vec2(u_waveTexel.x, 0.0));
  float gy = heightAt(u_wave, v_uv + vec2(0.0, u_waveTexel.y)) - heightAt(u_wave, v_uv - vec2(0.0, u_waveTexel.y));
  float slope = length(vec2(gx, gy)) / (2.0 * u_waveTexel.y);
  // Only real motion lights: crests and fast-moving water, not the slow swell.
  float e = 0.7 * smoothstep(0.15, 1.0, abs(v)) + 0.5 * smoothstep(0.35, 1.6, slope);
  float deep = 0.0, bloom = 0.0, hush = 0.0;
  for (int i = 0; i < 2; i++) {
    if (i >= u_handCount) break;
    vec4 h = u_hands[i];
    float d = length((v_uv - h.xy) * vec2(u_aspect, 1.0));
    deep = max(deep, h.w * exp(-pow(d / (h.z * (1.6 + 2.0 * h.w)), 2.0)));
    float br = d / (h.z * (0.45 + 0.6 * h.w) * (1.0 + 0.5 * u_offering * u_offer[i]));
    float near = exp(-br * br);
    bloom += u_contact[i] * near * (0.05 + 0.06 * h.w) * (1.0 + u_offering * u_offer[i]) * (1.0 - u_calming * u_calm[i]);
    hush = max(hush, u_contact[i] * u_calming * u_calm[i] * exp(-pow(d / (h.z * 1.6), 2.0)));
  }
  float add = u_gain * (e * 6.0 + bloom) * plankton(v_uv) * u_dt;
  g.r += (1.0 - g.r) * add * (1.0 - deep);
  g.g += (1.0 - g.g) * add * deep;
  // Idle twinkle: a sparse random speck lights and then fades like a single plankton.
  vec2 cell = floor(v_uv * u_glowSize);
  float tw = hash(vec3(cell, floor(u_time * 30.0)));
  if (tw > 1.0 - u_sparkle) g.r = max(g.r, 0.35 + 0.5 * hash(vec3(cell.yx, u_time)));
  // Under a palm turned down the light settles faster.
  g *= exp(-4.0 * hush * u_dt);
  g = max(g * u_decay - u_floor, 0.0);
  o = vec4(g, 1.0);
}`;

export const COMPOSITE = `${GLSL_HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_glow;
uniform vec3 u_tint, u_deep, u_wake;
uniform float u_bright;
${ghostFrameGlsl()}
void main() {
  vec3 g = texture(u_glow, v_uv).rgb;
  vec3 c = (u_tint * g.r + u_deep * g.g + u_wake * g.b) * u_bright;
  // Hot plankton whitens a little, as real bioluminescence does to the eye.
  c += vec3(0.35) * max(0.0, g.r + g.g - 0.55) * u_bright;
  o = vec4(ghostTone(c * ghostMask(v_uv)), 1.0);
}`;

export const EEL_VS = `${GLSL_HEADER}
in vec2 a_pos;
in vec2 a_attr; // point size in pixels, brightness
out float v_bright;
${ghostFrameGlsl()}
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = a_attr.x;
  v_bright = a_attr.y * ghostMask(a_pos);
}`;

export const EEL_FS = `${GLSL_HEADER}
in float v_bright; out vec4 o;
uniform vec3 u_color;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(d, d) * 5.0) * v_bright;
  o = vec4(u_color * a, a);
}`;
