/**
 * Tide (Living Water). An upright sheet of dark water seen face-on: the picture IS the surface and
 * the visitor pushes their fingers through it. See docs/LIVING.md.
 *
 * Water: a damped wave equation on a grid over the picture (Basin's packed height/rate field, with
 * absorbing edges). A hand behind the picture plane breathes gentle rings into it, drags a wake when
 * it moves and splashes as it enters; fingertips ring on their own. Light is bioluminescence: wave
 * motion excites a plankton buffer that fades over the persistence time, so still water is black
 * and a touch blooms outward. Reaching further through turns the glow wider and deeper in colour.
 *
 * School: 30–80 luminous eels (CPU, `school.ts`) wander and school. `Mood` decides the rest: a
 * still, patient hand draws them into a ring circling it; a splash scatters them to the dim edges;
 * they return after calm. They leave faint wakes in the plankton and pulse with the music's beat.
 *
 * Signals are the shared living five (`model.ts`). Emissive light on true black only, faded at the
 * calibrated active area and the weak top band.
 */
import { defineSimulation, type SimInput } from '../../core/types';
import { clamp01, rng } from '../../core/math';
import { hexToRgb } from '../../core/params';
import { beatPulse } from '../../core/music';
import { PingPong, bindScreen, pickFormat } from '../../gl/fbo';
import { drawQuad, quadProgram } from '../../gl/quad';
import { Program } from '../../gl/program';
import { areaUniform, LIVING_SIGNALS, Mood, pictureHands, type PictureHand } from '../living';
import { Forces, GLOW_SCALE, HandWater, TideSignals, agitationFrom, substeps, waveGrid } from './model';
import { School, SEGMENTS, closeRadius, type SchoolBounds } from './school';
import * as glsl from './shaders';

const SEED = 41;
/** Sub-points drawn per body link: enough that the glowing points read as one streak. */
const SUBS = 3;
const MAX_EELS = 80;

export default defineSimulation({
  id: 'tide',
  title: 'Tide',
  description: 'An upright sheet of dark water that glows where it is disturbed, home to a school of luminous eels.',
  hologramFrame: 'wall',
  params: {
    color: { kind: 'color', default: '#2fe6d2', label: 'Glow colour', description: 'Colour of the plankton light in the water (deeper reaches shift it toward blue).' },
    glow: { kind: 'number', default: 1, min: 0, max: 2, step: .05, label: 'Glow', description: 'Brightness of the water\'s light.' },
    persistence: { kind: 'number', default: 1.2, min: .3, max: 4, step: .05, unit: 's', label: 'Afterglow', description: 'How long disturbed water keeps glowing.' },
    waveSpeed: { kind: 'number', default: .3, min: .12, max: .6, step: .01, unit: '1/s', label: 'Wave speed', description: 'How fast rings travel, in picture heights per second.' },
    damping: { kind: 'number', default: .6, min: 0, max: 3, step: .05, unit: '1/s', label: 'Damping', description: 'How quickly waves die away.' },
    force: { kind: 'number', default: 1, min: 0, max: 2.5, step: .05, label: 'Touch force', description: 'How much water a touch moves.' },
    school: { kind: 'number', default: 48, min: 0, max: MAX_EELS, step: 1, label: 'School size', description: 'Number of eels.' },
    eelBrightness: { kind: 'number', default: .8, min: 0, max: 2, step: .05, label: 'Eel brightness', description: 'Brightness of the eels.' },
    glimmer: { kind: 'number', default: .5, min: 0, max: 1, step: .01, label: 'Idle glimmer', description: 'Faint twinkles and drops that keep the empty water alive, pulsing with the beat.' },
  },
  signals: LIVING_SIGNALS,
  stepHz: 60,
  create(ctx, initial) {
    const gl = ctx.gl;
    const glowFormat = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    const pWave = quadProgram(gl, glsl.WAVE, 'tide.wave');
    const pGlow = quadProgram(gl, glsl.GLOW, 'tide.glow');
    const pComposite = quadProgram(gl, glsl.COMPOSITE, 'tide.composite');
    const pEel = new Program(gl, glsl.EEL_VS, glsl.EEL_FS, 'tide.eel');

    let aspect = ctx.aspect;
    let wave!: PingPong, glowField!: PingPong;
    const buildFields = () => {
      const g = waveGrid(ctx.quality, aspect);
      wave = new PingPong(gl, g.width, g.height, 'rgba8', 'linear');
      wave.read.clear(...glsl.REST); wave.write.clear(...glsl.REST);
      glowField = new PingPong(gl, Math.round(g.width * GLOW_SCALE), Math.round(g.height * GLOW_SCALE), glowFormat, 'linear');
      glowField.clear();
    };
    buildFields();

    // Eel points: x, y (uv), size (px), brightness.
    const points = new Float32Array(MAX_EELS * SEGMENTS * SUBS * 4);
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!buffer || !vao) throw new Error('Tide: could not create the eel buffers.');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, points.byteLength, gl.DYNAMIC_DRAW);
    const aPos = pEel.attribute('a_pos'), aAttr = pEel.attribute('a_attr');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aAttr); gl.vertexAttribPointer(aAttr, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);

    /**
     * Where the eels may swim: inside the lit area, clear of its soft edge and the weak top band.
     * Fear widens it past the edge so frightened eels slip out into the faded margin rather than
     * lining up along it like a frame.
     */
    const bounds = (fear = 0): SchoolBounds => {
      const [x0, y0, x1, y1] = areaUniform(ctx.activeArea);
      const out = .2 * fear;
      return { x0: (x0 + .03 - out) * aspect, y0: y0 + .05 - out, x1: (x1 - .03 + out) * aspect, y1: y1 - .1 + out };
    };
    let school = new School(Math.min(MAX_EELS, initial.school), bounds(), SEED);
    const mood = new Mood();
    const water = new HandWater();
    const forces = new Forces();
    const signals = new TideSignals();
    const random = rng(SEED + 1);
    let time = 0, pulse = 0, dropIn = 1, lastBeat = -1;
    let hands: PictureHand[] = [];
    const handData = new Float32Array(8), contactData = new Float32Array(2);

    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);

    /** Write the eel bodies into `points`; returns the point count. */
    const fillPoints = (pxPerUnit: number, brightness: number, headsOnly: boolean) => {
      let n = 0;
      const beat = .75 + .5 * pulse;
      for (let i = 0; i < school.count; i++) {
        const k = i * SEGMENTS, size = school.size[i], light = brightness * beat * (1 - .75 * school.dim[i]) * (.85 + .15 * Math.sin(school.phase[i] * .31));
        if (headsOnly) {
          points[n * 4] = school.x[k] / aspect; points[n * 4 + 1] = school.y[k]; points[n * 4 + 2] = pxPerUnit * .03 * size; points[n * 4 + 3] = light; n++;
          continue;
        }
        for (let s = 0; s < SEGMENTS - 1; s++) {
          const ax = school.x[k + s], ay = school.y[k + s], bx = school.x[k + s + 1], by = school.y[k + s + 1];
          const lx = bx - ax, ly = by - ay, l = Math.sqrt(lx * lx + ly * ly) + 1e-6, nx = -ly / l, ny = lx / l;
          for (let j = 0; j < SUBS; j++) {
            const t = (s + j / SUBS) / (SEGMENTS - 1);
            // Swimming undulation grows toward the tail.
            const wig = .006 * size * t * Math.sin(school.phase[i] - t * 5.5);
            const px = ax + lx * j / SUBS + nx * wig, py = ay + ly * j / SUBS + ny * wig;
            points[n * 4] = px / aspect; points[n * 4 + 1] = py;
            points[n * 4 + 2] = pxPerUnit * .0068 * size * (1 - .65 * t);
            points[n * 4 + 3] = light * (t < .05 ? 1.4 : 1 - .75 * t);
            n++;
          }
        }
      }
      return n;
    };
    const drawPoints = (count: number, color: [number, number, number], area: [number, number, number, number], edge: number) => {
      if (count === 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, points, 0, count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      pEel.use().f3('u_color', color[0], color[1], color[2]).f4('u_area', ...area).f1('u_edge', edge);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    };

    return {
      step(input: SimInput, params) {
        const dt = input.dt;
        time = input.time;
        pulse = input.music ? beatPulse(input.music) : .5 + .5 * Math.sin(time * Math.PI * 2 / 5);
        const picture = pictureHands(input);
        hands = picture.hands;
        const primary = picture.primary;

        // Hands → disturbances, agitation, mood.
        forces.begin();
        water.update(hands, dt, time, aspect, params.force, forces);
        const agitation = agitationFrom(water.stir);
        const stillness = primary ? 1 - clamp01(primary.speed / .6) : 1;
        mood.update(dt, { presence: input.presence, stillness, agitation });

        // Idle drops: on the beat when music plays, else every second or so; quieter while someone is here.
        const idle = params.glimmer * (1 - .7 * input.presence);
        let drop = false;
        if (input.music?.playing) { const b = Math.floor(input.music.beat); if (b !== lastBeat) { drop = lastBeat >= 0 && random() < .6; lastBeat = b; } }
        else { dropIn -= dt; if (dropIn <= 0) { drop = true; dropIn = .6 + random() * 1.2; } }
        if (drop && idle > .01) {
          const b = bounds();
          forces.add((b.x0 + random() * (b.x1 - b.x0)) / aspect, b.y0 + random() * (b.y1 - b.y0), .012 + .01 * random(), (random() < .5 ? -1 : 1) * 1.8 * idle);
        }

        // The school.
        const hand = primary ? { x: primary.x * aspect, y: primary.y, radius: primary.radius * aspect } : null;
        school.update({ dt, boldness: mood.boldness, fear: mood.fear, hand, bounds: bounds(mood.fear) });
        const closeness = hand ? school.fractionWithin(hand.x, hand.y, closeRadius(hand.radius)) : 0;
        signals.update(dt, input.presence, primary, agitation, closeness);

        // The water: substeps, forces with the first.
        const rows = wave.height, n = substeps(params.waveSpeed, dt, rows), sub = dt / n;
        pWave.use().f2('u_texel', 1 / wave.width, 1 / wave.height).f1('u_dx', 1 / rows).f1('u_dt', sub).f1('u_c2', params.waveSpeed * params.waveSpeed)
          .f1('u_damp', params.damping).f1('u_aspect', aspect).f4v('u_forces', forces.data);
        for (let i = 0; i < n; i++) {
          pWave.i1('u_count', i === 0 ? forces.count : 0).texture('u_wave', wave.read.texture, 0);
          wave.write.bind(); drawQuad(gl); wave.swap();
        }

        // The plankton.
        const hc = Math.min(2, hands.length);
        for (let i = 0; i < hc; i++) {
          const h = hands[i];
          handData.set([h.x, h.y, h.radius * aspect, h.reach], i * 4);
          contactData[i] = h.contact;
        }
        const decay = Math.exp(-dt / Math.max(.05, params.persistence / 2.5));
        pGlow.use().texture('u_glow', glowField.read.texture, 0).texture('u_wave', wave.read.texture, 1)
          .f2('u_waveTexel', 1 / wave.width, 1 / wave.height).f2('u_glowSize', glowField.width, glowField.height)
          .f1('u_decay', decay).f1('u_floor', glowFormat === 'rgba8' ? .0025 : .0004).f1('u_gain', 1).f1('u_dt', dt).f1('u_aspect', aspect).f1('u_time', time)
          .f1('u_sparkle', 5e-5 * params.glimmer * (1 + 2 * pulse) * (1 - .5 * input.presence))
          .i1('u_handCount', hc).f4v('u_hands', handData).f1v('u_contact', contactData);
        glowField.write.bind(); drawQuad(gl); glowField.swap();

        // Eel wakes: the heads leave faint light in the water.
        if (school.count > 0) {
          glowField.read.bind();
          const count = fillPoints(glowField.height, .05 * params.eelBrightness, true);
          drawPoints(count, [0, 0, 1], [-1, -1, 2, 2], .001);
        }
      },
      render(frame, params) {
        const [r, g, b] = hexToRgb(params.color);
        const area = areaUniform(ctx.activeArea);
        bindScreen(gl, frame.width, frame.height);
        gl.disable(gl.BLEND);
        const bright = params.glow * 1.6;
        pComposite.use().texture('u_glow', glowField.read.texture, 0)
          .f3('u_tint', r, g, b).f3('u_deep', r * .35 + .1, g * .45 + .08, b * .6 + .45).f3('u_wake', r * .7 + .1, g * .8 + .1, b * .9 + .1)
          .f1('u_bright', bright).f4('u_area', ...area).f1('u_edge', .06);
        drawQuad(gl);
        if (school.count > 0 && params.eelBrightness > 0) {
          const count = fillPoints(frame.height, .12 * params.eelBrightness, false);
          drawPoints(count, [r * .55 + .4, g * .55 + .4, b * .55 + .4], area, .06);
        }
      },
      signals() { return signals.values(); },
      resize() {
        if (Math.abs(ctx.aspect - aspect) < 1e-4) return;
        school.rescaleX(ctx.aspect / aspect);
        aspect = ctx.aspect;
        wave.dispose(); glowField.dispose();
        buildFields();
      },
      paramChanged(name, value) {
        if (name === 'school') school = new School(Math.min(MAX_EELS, Number(value)), bounds(), SEED);
      },
      dispose() {
        wave.dispose(); glowField.dispose();
        pWave.dispose(); pGlow.dispose(); pComposite.dispose(); pEel.dispose();
        gl.deleteBuffer(buffer); gl.deleteVertexArray(vao);
      },
    };
  },
});
