/**
 * Murmuration (placeholder: replaced by the full simulation). See docs/LIVING.md.
 */
import { defineSimulation } from '../../core/types';
import { bindScreen } from '../../gl/fbo';
import { LIVING_SIGNALS } from '../living';

export default defineSimulation({
  id: 'murmuration',
  title: 'Murmuration',
  description: 'Thousands of motes of light flocking in the picture, gathering around a gentle hand and tearing apart at a fast one.',
  hologramFrame: 'wall',
  params: {},
  signals: LIVING_SIGNALS,
  create(ctx) {
    const gl = ctx.gl;
    let presence = 0;
    return {
      step(input) { presence = input.presence; },
      render(frame) { bindScreen(gl, frame.width, frame.height); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); },
      signals() { return { presence, reach: 0, lift: 0, closeness: 0, agitation: 0 }; },
      dispose() {},
    };
  },
});
