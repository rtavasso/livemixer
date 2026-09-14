import { describe, expect, it } from 'vitest';
import { PIXEL_BUDGET, renderSize } from '../../src/sim/gl/resolution';
import { WAVE_GRID, WAVE_SPEED } from '../../src/sim/sims/basin/waves';

describe('laptop render budget', () => {
  it('caps Retina and external displays without changing aspect or exceeding a tier', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      for (const [w, h] of [[1280, 800], [2560, 1600], [3840, 2160], [800, 1280]]) {
        const size = renderSize(w, h, 3, 2, quality);
        expect(size.width * size.height).toBeLessThanOrEqual(PIXEL_BUDGET[quality]);
        expect(Math.abs(size.width / size.height - w / h)).toBeLessThan(.005);
      }
    }
  });
  it('honours lower DPR requests and does not upscale a small non-Retina panel', () => {
    expect(renderSize(640, 400, 2, 1, 'medium')).toMatchObject({ width: 640, height: 400 });
    expect(renderSize(1280, 800, .5, 2, 'medium')).toMatchObject({ width: 640, height: 400 });
    expect(renderSize(1280, 800, 2, 2, 'medium')).toMatchObject({ width: 1280, height: 800 });
  });
  it('keeps the explicit wave solver within its two-dimensional CFL limit at every tier', () => {
    for (const n of Object.values(WAVE_GRID)) expect(WAVE_SPEED * (1 / 60) * n).toBeLessThan(1 / Math.sqrt(2));
  });
});
