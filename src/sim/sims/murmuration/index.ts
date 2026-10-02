/**
 * Murmuration. See docs/LIVING.md.
 *
 * Thousands of tiny motes of pale gold light flock in the picture like starlings at dusk:
 * folding ribbons and sheets that drift and swell faintly with the beat when nobody is there.
 * A hand pulls them from a distance and keeps them off its skin; held gently still, the flock
 * wraps it in an orbiting halo that tightens into a ring the longer it is trusted. A fast hand
 * tears the ribbons apart; they re-form over several seconds. Pushing through the picture draws
 * the flock in harder and lights the motes near the hand. Closing the hand draws the halo into a
 * small, dense, brighter ball; turning the palm up lifts it off the hand, turning it down settles
 * it below. With Live's output levels relayed, each rhythm hit brightens the motes and draws the
 * flock in for a breath, and the melodic parts set a slow shimmer running through it (drawing
 * only: the flock and its signals never hear the music, so it cannot feed back into itself).
 *
 * The flock is simulated on the CPU (`flock.ts`: uniform grid, O(n), deterministic). Each frame
 * the motes are uploaded (bufferSubData) and drawn as instanced, additive streak sprites from
 * last frame's position to this one's into a half-float accumulation target (RGBA8 fallback) that
 * decays over `trail` seconds, then composited with the ghost frame (active area and weak top
 * band fade to black) and a tone map.
 */
import { defineSimulation } from '../../core/types';
import { hexToRgb } from '../../core/params';
import { PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { Program } from '../../gl/program';
import { drawQuad, quadProgram } from '../../gl/quad';
import { LIVING_SIGNALS, areaUniform } from '../living';
import { MurmurationState } from './flock';
import { COMPOSITE_FS, DECAY_FS, MOTE_FS, MOTE_VS } from './shaders';

/** Soft edge of the ghost frame (uv). */
const EDGE = .035;
/** Tone-map exposure. */
const EXPOSURE = 6;

export default defineSimulation({
  id: 'murmuration',
  title: 'Murmuration',
  description: 'Thousands of motes of light flocking in the picture, gathering around a gentle hand and tearing apart at a fast one.',
  hologramFrame: 'wall',
  params: {
    count: { kind: 'number', default: 3000, min: 1000, max: 5000, step: 250, label: 'Motes', description: 'How many motes fly (CPU cost grows linearly: ~0.5 ms per 1,000 on a laptop).' },
    color: { kind: 'color', default: '#ffd592', label: 'Colour', description: 'Colour of the motes; far motes take a faint cool tint.' },
    moteSize: { kind: 'number', default: 2.4, min: 1, max: 6, step: .1, unit: 'px', label: 'Mote size', description: 'Sprite diameter of a near mote at 720 px picture height.' },
    brightness: { kind: 'number', default: 1, min: .2, max: 2.5, step: .05, label: 'Brightness' },
    flow: { kind: 'number', default: .55, min: 0, max: 1, step: .05, label: 'Flow', description: '0 = a cohesive, clumped flock; 1 = motes follow the large folding currents (ribbons and sheets).' },
    attraction: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Hand attraction', description: 'How strongly the hand draws the flock.' },
    gripTighten: { kind: 'number', default: .55, min: 0, max: .8, step: .05, label: 'Fist tightens', description: 'How far a closing fist draws the gathered halo into a small, dense, brighter ball (0 = no effect).' },
    palmLift: { kind: 'number', default: .11, min: 0, max: .25, step: .01, label: 'Palm lift', description: 'How far (picture heights) a palm turned up lifts the halo above the hand, or turned down settles it below.' },
    musicPulse: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Music pulse', description: 'How strongly each rhythm hit in Live brightens the motes and draws the flock in for a breath (0 = off). Needs the levels relayed from Live.' },
    musicShimmer: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Music shimmer', description: 'How strongly the melodic parts in Live set a slow shimmer running through the motes (0 = off).' },
    trail: { kind: 'number', default: .1, min: .03, max: .6, step: .01, unit: 's', label: 'Trail', description: 'How long a mote’s streak persists.' },
  },
  signals: LIVING_SIGNALS,
  create(ctx, initial) {
    const gl = ctx.gl;
    const state = new MurmurationState(initial.count, ctx.aspect);
    const format = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    let accum = new PingPong(gl, ctx.width, ctx.height, format);
    accum.clear();
    const moteProgram = new Program(gl, MOTE_VS, MOTE_FS, 'murmuration.motes');
    const decayProgram = quadProgram(gl, DECAY_FS, 'murmuration.decay');
    const compositeProgram = quadProgram(gl, COMPOSITE_FS, 'murmuration.composite');

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('Could not create the mote buffers.');
    let packed = new Float32Array(0), current = new Float32Array(0);
    let fresh = true;
    const allocate = () => {
      packed = new Float32Array(state.flock.n * 6);
      current = new Float32Array(state.flock.n * 4);
      fresh = true;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, packed.byteLength, gl.DYNAMIC_DRAW);
      const mote = moteProgram.attribute('a_mote'), prev = moteProgram.attribute('a_prev');
      gl.enableVertexAttribArray(mote);
      gl.vertexAttribPointer(mote, 4, gl.FLOAT, false, 24, 0);
      gl.vertexAttribDivisor(mote, 1);
      gl.enableVertexAttribArray(prev);
      gl.vertexAttribPointer(prev, 2, gl.FLOAT, false, 24, 16);
      gl.vertexAttribDivisor(prev, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };
    allocate();

    let lastRender = -1;
    let area = areaUniform(ctx.activeArea);
    const flockArea = { x0: 0, y0: 0, x1: 1, y1: 1 };

    return {
      step(input, params) {
        state.flock.setAspect(ctx.aspect);
        area = areaUniform(ctx.activeArea);
        flockArea.x0 = area[0]; flockArea.y0 = area[1]; flockArea.x1 = area[2]; flockArea.y1 = area[3];
        state.step(input, params, flockArea);
      },
      render(frame, params) {
        const dt = lastRender < 0 ? 1 / 60 : Math.min(.1, Math.max(0, frame.time - lastRender));
        lastRender = frame.time;
        const n = state.flock.n;
        if (current.length !== n * 4) allocate();
        // Interleave (x, y, depth, brightness, previous x, previous y); the previous is last frame's.
        for (let i = 0; i < n; i++) { packed[i * 6 + 4] = current[i * 4]; packed[i * 6 + 5] = current[i * 4 + 1]; }
        state.flock.pack(current, state.musicBreath, state.breathX, state.breathY);
        // A streak spans at most one 60 Hz frame of motion, so a slow frame never stretches motes into bright rods.
        const span = Math.min(1, (1 / 60) / Math.max(dt, 1e-4));
        for (let i = 0; i < n; i++) {
          const o = i * 6, c = i * 4;
          packed[o] = current[c]; packed[o + 1] = current[c + 1]; packed[o + 2] = current[c + 2]; packed[o + 3] = current[c + 3];
          if (fresh) { packed[o + 4] = current[c]; packed[o + 5] = current[c + 1]; }
          else { packed[o + 4] = current[c] + (packed[o + 4] - current[c]) * span; packed[o + 5] = current[c + 1] + (packed[o + 5] - current[c + 1]) * span; }
        }
        fresh = false;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
        // 1. Decay the previous frame into the write target.
        const trail = Math.max(.02, params.trail);
        const decay = Math.exp(-dt / trail);
        accum.write.bind();
        decayProgram.use().texture('u_prev', accum.read.texture, 0).f1('u_decay', decay).f1('u_floor', format === 'rgba8' ? 1.5 / 255 : 2e-4);
        drawQuad(gl);
        // 2. Motes, additive. Deposit ∝ dt / trail so a mote's steady brightness does not depend on the frame rate.
        gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
        const [r, g, b] = hexToRgb(params.color);
        const pulse = state.pulse;
        const gain = params.brightness * (1 - decay) * (1 + .18 * pulse) * (1 + state.musicGlow);
        moteProgram.use()
          .f2('u_px', accum.width, accum.height)
          .f1('u_size', params.moteSize * ctx.height / 720)
          .f1('u_maxStreak', .02 * accum.height)
          .f1('u_gain', gain)
          .f3('u_color', r, g, b)
          .f3('u_cool', .62, .78, 1)
          .f1('u_shimmer', .35 * state.shimmer)
          .f1('u_phase', (frame.time * 1.3) % (Math.PI * 2));
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        // 3. Composite to the screen.
        bindScreen(gl, frame.width, frame.height);
        compositeProgram.use().texture('u_accum', accum.write.texture, 0)
          .f1('u_exposure', EXPOSURE)
          .f4('u_area', area[0], area[1], area[2], area[3]).f1('u_edge', EDGE);
        drawQuad(gl);
        accum.swap();
      },
      signals() { return state.signals(); },
      resize(width, height) {
        accum.dispose();
        accum = new PingPong(gl, width, height, format);
        accum.clear();
      },
      paramChanged(name, value) {
        if (name === 'count' && typeof value === 'number') state.setCount(value);
      },
      dispose() {
        accum.dispose(); moteProgram.dispose(); decayProgram.dispose(); compositeProgram.dispose();
        gl.deleteBuffer(buffer); gl.deleteVertexArray(vao);
      },
    };
  },
});
