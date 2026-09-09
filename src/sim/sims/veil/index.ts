/**
 * Veil — a sheer curtain hanging from the top of the frame, breathing in a
 * breeze from a dim window behind it. A hand touches, pushes and sweeps
 * through it; the fabric wraps around the hand and trails behind it.
 *
 * Physics: `cloth.ts` (CPU position-based dynamics, deterministic) driven by
 * `wind.ts` (curl-noise breeze with gusts). Rendering: an indexed triangle
 * mesh whose positions and normals are re-uploaded every frame, drawn with
 * premultiplied blending into a float scene target over a dark background,
 * then a small post pass (exposure, gamma, dither).
 *
 * Coordinates: uniform units (canvas height = 1, width = aspect). z points
 * TOWARD THE VIEWER: the curtain rests at z = 0, the breeze billows it to +z,
 * and a hand — arriving from the viewer's side — sits in front of the sheet
 * when withdrawn (push = 0) and passes through to −z when pushed in.
 */
import { defineSimulation, type ParamSpecs, type ParamValues, type Quality } from '../../core/types';
import { approach, clamp, clamp01 } from '../../core/math';
import { defaultParams, hexToRgb } from '../../core/params';
import { bindScreen, Fbo, pickFormat } from '../../gl/fbo';
import { Program } from '../../gl/program';
import { drawQuad, quadProgram } from '../../gl/quad';
import { Cloth, type ClothStepParams } from './cloth';
import { HandColliders } from './colliders';
import { WindField } from './wind';
import { BACKGROUND_FS, CLOTH_FS, CLOTH_VS, POST_FS } from './shaders';

interface GridSpec { cols: number; rows: number; substeps: number; iterations: number }
/** `high` is sized to keep a step under ~2 ms on the installation's 2020 Intel MacBook (64×96 measured over budget). */
const GRID: Record<Quality, GridSpec> = {
  low: { cols: 40, rows: 60, substeps: 2, iterations: 2 },
  medium: { cols: 52, rows: 78, substeps: 2, iterations: 1 },
  high: { cols: 56, rows: 84, substeps: 2, iterations: 1 },
};

/** Rod slightly above the frame, hem just above the floor, side margins so the edges can swing. */
const ROD_TOP = 1.03, ROD_MARGIN = .08, LENGTH = .99, GATHER = 1.22;
/** Perspective: the camera sits at z = 1 / PERSPECTIVE_K in front of the canvas centre. */
const PERSPECTIVE_K = .22;
/** Settle steps (no hands) before the first frame, and after the rod moves on an aspect change. */
const PREROLL_STEPS = 45, RESETTLE_STEPS = 30;

const PARAMS = {
  wind: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Wind', description: 'Strength of the breeze through the window behind the curtain.' },
  gustiness: { kind: 'number', default: .4, min: 0, max: 1, step: .01, label: 'Gustiness', description: 'How often and how hard gusts arrive on top of the steady breeze.' },
  stiffness: { kind: 'number', default: .6, min: 0, max: 1, step: .01, label: 'Stiffness', description: 'Resistance to shearing and bending: low is a limp voile, high a crisp organza with wide folds.' },
  damping: { kind: 'number', default: .3, min: 0, max: 1, step: .01, label: 'Damping', description: 'How quickly motion dies away.' },
  drape: { kind: 'number', default: .45, min: 0, max: 1, step: .01, label: 'Drape', description: 'Weight of the fabric (gravity). Heavier hangs straighter, swings slower and resists the wind more.' },
  opacity: { kind: 'number', default: .2, min: .05, max: .9, step: .01, label: 'Opacity', description: 'Coverage of the sheet seen face-on. Folds seen edge-on are always denser.' },
  backlight: { kind: 'number', default: .7, min: 0, max: 1, step: .01, label: 'Backlight', description: 'Brightness of the warm light behind the curtain.' },
  tint: { kind: 'color', default: '#ffbf80', label: 'Tint', description: 'Colour of the backlight and therefore of the fabric.' },
  reach: { kind: 'number', default: .4, min: .1, max: 1, step: .01, label: 'Reach', description: 'How far a full push carries the hand through the curtain, in uniform units (canvas height = 1).' },
  weave: { kind: 'number', default: .5, min: 0, max: 1, step: .01, label: 'Weave', description: 'Visibility of the fine thread texture.' },
} satisfies ParamSpecs;

export default defineSimulation({
  id: 'veil',
  title: 'Veil',
  description: 'A sheer curtain moving in a breeze from a dim window behind it. The hand touches, pushes and sweeps through the fabric, which wraps around it and trails behind.',
  params: PARAMS,
  signals: {
    sway: { min: 0, max: 1, description: 'Mean lateral displacement of the fabric from its hanging position, normalised (0.12 units = 1).', smoothing: .2 },
    flutter: { min: 0, max: 1, description: 'Mean speed of the fabric, normalised (0.6 units/s = 1), lightly smoothed.', smoothing: .1 },
    contact: { min: 0, max: 1, description: 'Share of the fabric within a hand\'s reach (surface + skin), normalised so one hand pressed into the sheet reads about 0.5 (30% of points = 1).', smoothing: .1 },
    depth: { min: -1, max: 1, description: 'Mean depth of the fabric: positive billows toward the viewer, negative is pushed away (0.2 units = 1).', smoothing: .2 },
    gust: { min: 0, max: 1, description: 'Current gust envelope.', smoothing: .3 },
    tension: { min: 0, max: 1, description: 'Mean constraint strain above the resting level, normalised (6% = 1). Rises when a hand stretches the sheet.', smoothing: .1 },
  },
  stepHz: 60,
  create(ctx, initial?: ParamValues<typeof PARAMS>) {
    const gl = ctx.gl;
    const grid = GRID[ctx.quality];
    let aspect = ctx.aspect;
    const folds = Math.max(4, Math.round((1 - 2 * ROD_MARGIN) * aspect / .21));
    const cloth = new Cloth({ cols: grid.cols, rows: grid.rows, rodX0: ROD_MARGIN * aspect, rodX1: (1 - ROD_MARGIN) * aspect, top: ROD_TOP, length: LENGTH, gather: GATHER, folds, seed: 11 });
    const wind = new WindField({ cols: cloth.windCols, rows: cloth.windRows, seed: 7, stride: 2 });
    const clothParams: ClothStepParams = { gravity: 3, damping: 1, stiffness: .6, dragNormal: 3, dragTangent: .4, friction: .8, substeps: grid.substeps, iterations: grid.iterations };
    const applyParams = (p: { drape: number; damping: number; stiffness: number }) => {
      clothParams.gravity = 1 + 5 * p.drape;
      clothParams.damping = .3 + 3 * p.damping;
      clothParams.stiffness = p.stiffness;
    };

    // Hands → sphere colliders that grow in on arrival and shrink out on departure (no snapping).
    const colliders = new HandColliders();

    // Interpolation state for rendering between fixed steps.
    const n = cloth.count;
    const renderPrev = new Float64Array(n * 3);
    const renderPos = new Float64Array(n * 3);
    const vertexData = new Float32Array(n * 6);

    // --- GPU resources
    const background = quadProgram(gl, BACKGROUND_FS, 'veil-background');
    const clothProgram = new Program(gl, CLOTH_VS, CLOTH_FS, 'veil-cloth');
    const post = quadProgram(gl, POST_FS, 'veil-post');
    const sceneFormat = pickFormat(ctx.capabilities, ['rgba16f', 'rgba8']);
    let scene = new Fbo(gl, ctx.width, ctx.height, sceneFormat, 'linear');
    const vbo = gl.createBuffer(), uvbo = gl.createBuffer(), ibo = gl.createBuffer(), vao = gl.createVertexArray();
    if (!vbo || !uvbo || !ibo || !vao) throw new Error('Could not allocate the curtain mesh.');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.DYNAMIC_DRAW);
    const aPosition = clothProgram.attribute('a_position'), aNormal = clothProgram.attribute('a_normal'), aUv = clothProgram.attribute('a_uv');
    if (aPosition >= 0) { gl.enableVertexAttribArray(aPosition); gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 24, 0); }
    if (aNormal >= 0) { gl.enableVertexAttribArray(aNormal); gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12); }
    gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
    gl.bufferData(gl.ARRAY_BUFFER, cloth.uv, gl.STATIC_DRAW);
    if (aUv >= 0) { gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 8, 0); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cloth.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    // Signal baselines: the resting sheet's own fold offset and constraint strain, so `sway` and `tension`
    // read zero when nothing is happening. Recaptured whenever the rod moves.
    let swayBase = 0, strainBase = 0;
    /**
     * Run the sheet with no hands (the current wind is fine: its effect on the baselines is negligible) until it
     * has settled, then take the baselines and put the render history on the settled positions so the next
     * frame does not interpolate from wherever the sheet was before.
     */
    const settle = (steps: number) => {
      for (let i = 0; i < steps; i++) cloth.step(1 / 60, clothParams, colliders.data, 0);
      swayBase = cloth.meanAbsDx; strainBase = cloth.meanStrain * .9;
      renderPrev.set(cloth.pos); renderPos.set(cloth.pos);
    };

    // --- settle the seeded folds before the first frame (still air, no hands)
    applyParams(initial ?? defaultParams(PARAMS));
    settle(PREROLL_STEPS);

    const signalValues = { sway: 0, flutter: 0, contact: 0, depth: 0, gust: 0, tension: 0 };
    let flutter = 0;

    return {
      step(input, params) {
        applyParams(params);
        colliders.update(input.hands, input.dt, aspect, params.reach);
        // A quiet room stays a little calmer; a busy hand stirs the air.
        const changed = wind.update({ time: input.time, dt: input.dt, wind: params.wind * (.85 + .15 * input.presence), gustiness: params.gustiness, turbulence: .5 * input.activity, x0: cloth.rodX0, x1: cloth.rodX1, top: ROD_TOP, length: LENGTH });
        if (changed) cloth.wind.set(wind.data);
        renderPrev.set(cloth.pos);
        cloth.step(input.dt, clothParams, colliders.data, colliders.count);
        flutter = approach(flutter, clamp01(cloth.meanSpeed / .6), input.dt, .12);
        signalValues.sway = clamp01(Math.max(0, cloth.meanAbsDx - swayBase) / .12);
        signalValues.flutter = flutter;
        signalValues.contact = clamp01(cloth.contactFraction / .3);
        signalValues.depth = clamp(cloth.meanZ / .2, -1, 1);
        signalValues.gust = clamp01(wind.gust);
        signalValues.tension = clamp01(Math.max(0, cloth.meanStrain - strainBase) / .06);
      },
      render(frame, params) {
        // Interpolate between the last two physics states, rebuild normals, upload.
        const a = frame.alpha, pos = cloth.pos;
        for (let i = 0; i < n * 3; i++) renderPos[i] = renderPrev[i] + (pos[i] - renderPrev[i]) * a;
        cloth.computeNormals(renderPos, vertexData, 6, 3);
        for (let i = 0; i < n; i++) { const o = i * 3, v = i * 6; vertexData[v] = renderPos[o]; vertexData[v + 1] = renderPos[o + 1]; vertexData[v + 2] = renderPos[o + 2]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        const [tr, tg, tb] = hexToRgb(params.tint);
        const cx = aspect * .5;
        // 1. background into the scene target
        scene.bind();
        gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
        background.use().f1('u_aspect', aspect).f3('u_tint', tr, tg, tb).f1('u_backlight', params.backlight).f4('u_window', cx, .56, .27 * aspect, .3);
        drawQuad(gl);
        // 2. the sheet, both faces, premultiplied over
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        clothProgram.use().f1('u_aspect', aspect).f1('u_k', PERSPECTIVE_K)
          .f1('u_opacity', params.opacity).f1('u_backlight', params.backlight).f1('u_weave', params.weave)
          .f3('u_tint', tr, tg, tb).f3('u_cam', cx, .5, 1 / PERSPECTIVE_K).f3('u_light', cx, .62, -.9)
          .f2('u_threads', 340, 230).f2('u_fade', 1.5 / (cloth.cols - 1), 1.5 / (cloth.rows - 1));
        gl.bindVertexArray(vao);
        gl.drawElements(gl.TRIANGLES, cloth.indices.length, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        // 3. tone, gamma, dither to the screen
        bindScreen(gl, frame.width, frame.height);
        post.use().texture('u_scene', scene.texture, 0).f1('u_exposure', 1.1);
        drawQuad(gl);
      },
      signals() { return signalValues; },
      resize(width, height) {
        scene.dispose();
        scene = new Fbo(gl, width, height, sceneFormat, 'linear');
        const next = width / Math.max(1, height);
        if (Math.abs(next - aspect) > 1e-3) {
          // The rod follows the frame; the sheet reflows with it and settles before the baselines are retaken,
          // otherwise `tension` pegs for a second and `sway` keeps a permanent offset.
          aspect = next;
          cloth.setExtent(ROD_MARGIN * aspect, (1 - ROD_MARGIN) * aspect);
          settle(RESETTLE_STEPS);
        }
      },
      dispose() {
        background.dispose(); clothProgram.dispose(); post.dispose(); scene.dispose();
        gl.deleteVertexArray(vao); gl.deleteBuffer(vbo); gl.deleteBuffer(uvbo); gl.deleteBuffer(ibo);
      },
    };
  },
});
