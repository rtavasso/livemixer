/**
 * Veil — a sheer curtain hanging inside the volume, breathing in a breeze
 * from a dim window on the back wall. The hand is a solid in the volume —
 * finger bones, palm and forearm when the source knows the skeleton
 * (`hand.capsules`), a sphere at its position otherwise: in front of the sheet
 * it hovers without touching, at the sheet each finger pokes its own pocket
 * and a flat palm presses a palm-shaped one, and deeper than the sheet it
 * passes through, the fabric wrapping around it and trailing behind; from
 * behind, the backlight throws its soft silhouette onto the fabric and the
 * hand itself shows through the gauze as a dark shape.
 *
 * Physics: `cloth.ts` (CPU position-based dynamics, deterministic) driven by
 * `wind.ts` (curl-noise breeze with gusts), hands from `colliders.ts` (the
 * capsules in the cloth's frame, padded, with a bounding sphere per hand).
 * Rendering: the room — floor, back wall and window — is ray-cast in one
 * full-screen pass, which also sphere-traces the hands through `handSdfGlsl`
 * inside their bounding spheres; the sheet is an indexed mesh (positions and
 * normals re-uploaded every frame) projected by the shared window camera and
 * drawn with premultiplied blending into a float scene target; a small post
 * pass applies exposure, gamma and dither.
 *
 * Coordinates. The volume is `[0, aspect] × [0, 1] × [0, depth]` in uniform
 * units with z INTO the scene (`toWorld`, `windowCamera`); the floor is y = 0
 * and the window sits on the back wall z = depth. The sheet hangs at the plane
 * z = plane · depth (`plane` param) from a rod above the view. The cloth solver
 * keeps its own frame — x and y as the volume, z measured from the resting
 * plane TOWARD THE VIEWER, so the breeze from the window billows it to +z —
 * and the conversion happens at exactly two boundaries: hands entering
 * (`HandColliders`: cloth z = plane − world z, cloth vz = −world vz) and
 * vertices leaving (`CLOTH_VS`: world z = plane − cloth z, normal z negated).
 * The `depth` signal is reported in the volume's sense: positive = deeper.
 *
 * Sizing. The window camera shrinks things at depth z by eye / (eye + z), so
 * the rod is (eye + z) / eye times as wide as the glass to fill the view at the
 * sheet's depth and hangs just above the visible top there; the hem stops just
 * above the floor. Moving the plane (or resizing) re-hangs the sheet and lets
 * it settle before the signal baselines are retaken.
 */
import { defineSimulation, type ParamSpecs, type ParamValues, type Quality, type SimInput } from '../../core/types';
import { approach, clamp, clamp01 } from '../../core/math';
import { DEFAULT_EYE, windowCamera } from '../../core/camera';
import { defaultParams, hexToRgb } from '../../core/params';
import { bindScreen, Fbo, pickFormat } from '../../gl/fbo';
import { createPackedHands } from '../../gl/hand';
import { Program } from '../../gl/program';
import { drawQuad, quadProgram } from '../../gl/quad';
import { SurfaceTexture } from '../../gl/surface';
import { Cloth, NO_COLLIDERS, type ClothStepParams } from './cloth';
import { HandColliders } from './colliders';
import { SCAN_THICKNESS } from './scan';
import { WindField } from './wind';
import { BACKGROUND_FS, CLOTH_FS, CLOTH_VS, POST_FS } from './shaders';

interface GridSpec { cols: number; rows: number; substeps: number; iterations: number }
/** `high` is sized to keep a step under ~2 ms on the installation's 2020 Intel MacBook (64×96 measured over budget). */
const GRID: Record<Quality, GridSpec> = {
  low: { cols: 40, rows: 60, substeps: 2, iterations: 2 },
  medium: { cols: 52, rows: 78, substeps: 2, iterations: 1 },
  high: { cols: 56, rows: 84, substeps: 2, iterations: 1 },
};

/** The window camera's eye distance; the sheet is sized from it. */
const EYE = DEFAULT_EYE;
/** Rod: overhang past each side of the view at the sheet's depth (fraction of the visible width), height above the visible top there; hem height above the floor. */
const ROD_MARGIN = -.02, ROD_ABOVE = .03, HEM = .015;
/** Fabric width over rod span (>1 gathers it into folds), and the fold wavelength at the glass (scaled with depth). */
const GATHER = 1.22, FOLD_WAVELENGTH = .21;
/** How far behind the back wall the window's light sits (softens its falloff across the sheet). */
const LIGHT_BEHIND = .3;
/** Settle steps (no hands) before the first frame, and after the sheet is re-hung (aspect or plane change). */
const PREROLL_STEPS = 45, RESETTLE_STEPS = 30;

export interface SheetLayout { x0: number; x1: number; top: number; length: number; scale: number }
/**
 * Rod ends, rod height and fabric length for a sheet hanging at world depth `planeZ`, sized to fill the view
 * there: the visible half-extents at that depth are the glass's times `scale = (eye + z) / eye`.
 */
export function layoutFor(aspect: number, planeZ: number): SheetLayout {
  const scale = (EYE + planeZ) / EYE;
  const cx = aspect * .5, hw = cx * scale * (1 - 2 * ROD_MARGIN), top = .5 + .5 * scale + ROD_ABOVE;
  return { x0: cx - hw, x1: cx + hw, top, length: top - HEM, scale };
}

const PARAMS = {
  wind: { kind: 'number', default: .35, min: 0, max: 1, step: .01, label: 'Wind', description: 'Strength of the breeze through the window behind the curtain.' },
  gustiness: { kind: 'number', default: .4, min: 0, max: 1, step: .01, label: 'Gustiness', description: 'How often and how hard gusts arrive on top of the steady breeze.' },
  stiffness: { kind: 'number', default: .6, min: 0, max: 1, step: .01, label: 'Stiffness', description: 'Resistance to shearing and bending: low is a limp voile, high a crisp organza with wide folds.' },
  damping: { kind: 'number', default: .3, min: 0, max: 1, step: .01, label: 'Damping', description: 'How quickly motion dies away.' },
  drape: { kind: 'number', default: .45, min: 0, max: 1, step: .01, label: 'Drape', description: 'Weight of the fabric (gravity). Heavier hangs straighter, swings slower and resists the wind more.' },
  opacity: { kind: 'number', default: .2, min: .05, max: .9, step: .01, label: 'Opacity', description: 'Coverage of the sheet seen face-on. Folds seen edge-on are always denser.' },
  backlight: { kind: 'number', default: .7, min: 0, max: 1, step: .01, label: 'Backlight', description: 'Brightness of the warm light behind the curtain.' },
  tint: { kind: 'color', default: '#ffbf80', label: 'Tint', description: 'Colour of the backlight and therefore of the fabric.' },
  plane: { kind: 'number', default: .45, min: .05, max: .95, step: .01, label: 'Plane', description: 'Depth at which the curtain hangs, as a fraction of the volume depth: 0 at the glass, 1 at the back wall. A hand nearer the glass hovers in front of the sheet; a deeper one passes through it.' },
  weave: { kind: 'number', default: .5, min: 0, max: 1, step: .01, label: 'Weave', description: 'Visibility of the fine thread texture.' },
} satisfies ParamSpecs;

export default defineSimulation({
  id: 'veil',
  title: 'Veil',
  description: 'A sheer curtain hanging in the volume, moving in a breeze from a dim window on the back wall. The hand hovers in front of the fabric, presses and sweeps it at its depth, and passes through it beyond, the fabric wrapping around it and trailing behind.',
  params: PARAMS,
  signals: {
    sway: { min: 0, max: 1, description: 'Mean lateral displacement of the fabric from its hanging position, normalised (0.12 units = 1).', smoothing: .2 },
    flutter: { min: 0, max: 1, description: 'Mean speed of the fabric, normalised (0.6 units/s = 1), lightly smoothed.', smoothing: .1 },
    contact: { min: 0, max: 1, description: 'Share of the fabric touching a hand (on its surface or within a thin skin), normalised so one hand pressed into the sheet reads about 0.5.', smoothing: .1 },
    depth: { min: -1, max: 1, description: 'Mean displacement of the fabric along the volume\'s depth from its hanging plane: negative billows toward the viewer, positive is pushed deeper (0.3 units = 1).', smoothing: .2 },
    gust: { min: 0, max: 1, description: 'Current gust envelope.', smoothing: .3 },
    tension: { min: 0, max: 1, description: 'Mean constraint strain above the resting level, normalised (6% = 1). Rises when a hand stretches the sheet.', smoothing: .1 },
  },
  stepHz: 60,
  create(ctx, initial?: ParamValues<typeof PARAMS>) {
    const gl = ctx.gl;
    const grid = GRID[ctx.quality];
    const depth = ctx.depth;
    let aspect = ctx.aspect;
    const first = initial ?? defaultParams(PARAMS);
    let plane = first.plane, planeZ = plane * depth;
    let layout = layoutFor(aspect, planeZ);
    let camera = windowCamera(aspect, depth);
    const folds = Math.max(4, Math.round((layout.x1 - layout.x0) / (FOLD_WAVELENGTH * layout.scale)));
    const cloth = new Cloth({ cols: grid.cols, rows: grid.rows, rodX0: layout.x0, rodX1: layout.x1, top: layout.top, length: layout.length, gather: GATHER, folds, floor: 0, seed: 11 });
    const wind = new WindField({ cols: cloth.windCols, rows: cloth.windRows, seed: 7, stride: 2 });
    const clothParams: ClothStepParams = { gravity: 3, damping: 1, stiffness: .6, dragNormal: 3, dragTangent: .4, friction: .8, substeps: grid.substeps, iterations: grid.iterations };
    const applyParams = (p: { drape: number; damping: number; stiffness: number }) => {
      clothParams.gravity = 1 + 5 * p.drape;
      clothParams.damping = .3 + 3 * p.damping;
      clothParams.stiffness = p.stiffness;
    };

    // Hands → capsule colliders (or a sphere for a hand without a shape) that grow in on arrival and shrink out on
    // departure (no snapping); with a depth camera, the scan is the solid instead.
    const colliders = new HandColliders();
    // The same capsules in world space, with their bounding spheres, for the shaders; and the scan as a texture.
    const packed = createPackedHands();
    const surfaceTexture = new SurfaceTexture(gl);
    let surface: SimInput['surface'] = null;

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
    // read zero when nothing is happening. Recaptured whenever the sheet is re-hung. `contactNorm` keeps
    // "one hand pressed in ≈ 0.5" true whatever the sheet's size (a deeper sheet is larger, the hand is not).
    let swayBase = 0, strainBase = 0, contactNorm = .3;
    /**
     * Run the sheet with no hands (the current wind is fine: its effect on the baselines is negligible) until it
     * has settled, then take the baselines and put the render history on the settled positions so the next
     * frame does not interpolate from wherever the sheet was before.
     */
    const settle = (steps: number) => {
      for (let i = 0; i < steps; i++) cloth.step(1 / 60, clothParams, NO_COLLIDERS);
      swayBase = cloth.meanAbsDx; strainBase = cloth.meanStrain * .9;
      contactNorm = .3 / (layout.scale * layout.scale);
      renderPrev.set(cloth.pos); renderPos.set(cloth.pos);
    };
    /** Re-hang the sheet for the current aspect and plane, then settle it and retake the baselines. */
    const rehang = () => {
      layout = layoutFor(aspect, planeZ);
      cloth.setExtent(layout.x0, layout.x1, layout.top, layout.length);
      settle(RESETTLE_STEPS);
    };

    // --- settle the seeded folds before the first frame (still air, no hands)
    applyParams(first);
    settle(PREROLL_STEPS);

    const signalValues = { sway: 0, flutter: 0, contact: 0, depth: 0, gust: 0, tension: 0 };
    let flutter = 0;

    return {
      step(input, params) {
        applyParams(params);
        if (params.plane !== plane) { plane = params.plane; planeZ = plane * depth; rehang(); }
        surface = input.surface;
        colliders.update(input.hands, input.dt, aspect, depth, planeZ, surface);
        // A quiet room stays a little calmer; a busy hand stirs the air.
        const changed = wind.update({ time: input.time, dt: input.dt, wind: params.wind * (.85 + .15 * input.presence), gustiness: params.gustiness, turbulence: .5 * input.activity, x0: cloth.rodX0, x1: cloth.rodX1, top: cloth.top, length: cloth.length });
        if (changed) cloth.wind.set(wind.data);
        renderPrev.set(cloth.pos);
        cloth.step(input.dt, clothParams, colliders);
        flutter = approach(flutter, clamp01(cloth.meanSpeed / .6), input.dt, .12);
        signalValues.sway = clamp01(Math.max(0, cloth.meanAbsDx - swayBase) / .12);
        signalValues.flutter = flutter;
        signalValues.contact = clamp01(cloth.contactFraction / contactNorm);
        // The cloth measures z toward the viewer; the volume's z runs the other way.
        signalValues.depth = clamp(-cloth.meanZ / .3, -1, 1);
        signalValues.gust = clamp01(wind.gust);
        signalValues.tension = clamp01(Math.max(0, cloth.meanStrain - strainBase) / .06);
      },
      render(frame, params) {
        if (frame.aspect !== camera.aspect) camera = windowCamera(frame.aspect, depth);
        // Interpolate between the last two physics states, rebuild normals, upload.
        const a = frame.alpha, pos = cloth.pos;
        for (let i = 0; i < n * 3; i++) renderPos[i] = renderPrev[i] + (pos[i] - renderPrev[i]) * a;
        cloth.computeNormals(renderPos, vertexData, 6, 3);
        for (let i = 0; i < n; i++) { const o = i * 3, v = i * 6; vertexData[v] = renderPos[o]; vertexData[v + 1] = renderPos[o + 1]; vertexData[v + 2] = renderPos[o + 2]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        // Hands as world-space capsules with the eased radii the cloth actually feels, or the scan as a texture
        // (the capsules pack empty then). The room pass shows whatever part of a hand has reached the sheet's
        // plane; the sheet pass shadows the fabric with it.
        colliders.packWorld(planeZ, packed);
        const shell = colliders.shell, scanReady = shell.active && surfaceTexture.upload(surface);
        const bindHands = (program: Program) => program
          .f4v('u_capsules', packed.capsules).i1('u_capsuleCount', packed.count).f4v('u_handBounds', packed.bounds).i1('u_handBoundCount', packed.boundCount)
          .texture('u_surface', scanReady ? surfaceTexture.texture : null, 0).i1('u_surfaceReady', scanReady ? 1 : 0)
          .f2('u_surfaceTexel', 1 / Math.max(1, surfaceTexture.width), 1 / Math.max(1, surfaceTexture.height)).f1('u_surfaceAspect', aspect).f1('u_surfaceDepth', depth)
          .f3('u_scanMin', shell.x0, shell.y0, shell.z0).f3('u_scanMax', shell.x1, shell.y1, shell.z1).f1('u_scanThick', SCAN_THICKNESS * depth);

        const [tr, tg, tb] = hexToRgb(params.tint);
        const cx = aspect * .5;
        // The window on the back wall, sized from the wall's visible extent so it reads alike at any volume depth.
        const wallScale = (EYE + depth) / EYE, wallHalfH = .5 * wallScale;
        const wx = cx, wy = .5 + .12 * wallHalfH, ww = .38 * cx * wallScale, wh = .44 * wallHalfH;
        // 1. the room (and the hands behind the sheet) into the scene target
        scene.bind();
        gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
        bindHands(background.use().f1('u_aspect', aspect).f1('u_depth', depth).f1('u_eye', EYE).f1('u_plane', planeZ)
          .f3('u_tint', tr, tg, tb).f1('u_backlight', params.backlight).f4('u_window', wx, wy, ww, wh));
        drawQuad(gl);
        // 2. the sheet, both faces, premultiplied over
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        bindHands(clothProgram.use().matrix4('u_matrix', camera.matrix).f1('u_plane', planeZ)
          .f1('u_opacity', params.opacity).f1('u_backlight', params.backlight).f1('u_weave', params.weave)
          .f3('u_tint', tr, tg, tb).f3('u_cam', cx, .5, -EYE).f3('u_light', wx, wy, depth + LIGHT_BEHIND)
          .f2('u_threads', 340, 230).f2('u_fade', 1.5 / (cloth.cols - 1), 1.5 / (cloth.rows - 1)));
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
          camera = windowCamera(aspect, depth);
          rehang();
        }
      },
      dispose() {
        background.dispose(); clothProgram.dispose(); post.dispose(); scene.dispose(); surfaceTexture.dispose();
        gl.deleteVertexArray(vao); gl.deleteBuffer(vbo); gl.deleteBuffer(uvbo); gl.deleteBuffer(ibo);
      },
    };
  },
});
