import { describe, expect, it } from 'vitest';
import { rotationFromUrl, SimRotation } from '../../src/sim/host/rotation';

const settings = { ids: ['tide', 'lantern', 'murmuration'], intervalMs: 60_000, quietMs: 4000, fadeMs: 2500, emptyBelow: .05 };
function run(r: SimRotation, from: number, to: number, presence: (t: number) => number) {
  const switches: { at: number; id: string }[] = []; let opacity = 1;
  for (let t = from; t <= to; t += 100) { const out = r.tick(t, presence(t)); opacity = out.opacity; if (out.switchTo) switches.push({ at: t, id: out.switchTo }); }
  return { switches, opacity };
}

describe('simulation rotation', () => {
  it('switches to the next simulation through black once due and the box is empty', () => {
    const r = new SimRotation(settings, 'tide');
    const { switches, opacity } = run(r, 0, 70_000, () => 0);
    expect(switches).toEqual([{ at: 62_500, id: 'lantern' }]);
    expect(opacity).toBe(1);
  });
  it('waits while someone is at the box and for a quiet spell afterwards', () => {
    const r = new SimRotation(settings, 'tide');
    const { switches } = run(r, 0, 100_000, t => t < 80_000 ? 1 : 0);
    expect(switches.map(s => s.at)).toEqual([86_500]);
  });
  it('cancels a fade-out when a hand arrives and fades back in', () => {
    const r2 = new SimRotation(settings, 'tide');
    run(r2, 0, 61_000, () => 0);
    const mid = r2.tick(61_100, 1);
    expect(mid.switchTo).toBeNull(); expect(mid.opacity).toBeLessThan(1);
    const { switches, opacity } = run(r2, 61_200, 66_000, () => 1);
    expect(switches).toEqual([]); expect(opacity).toBe(1);
  });
  it('cycles through the list and wraps', () => {
    const r = new SimRotation(settings, 'murmuration');
    const { switches } = run(r, 0, 70_000, () => 0);
    expect(switches[0].id).toBe('tide');
  });
  it('reads the URL and ignores unknown or too few simulations', () => {
    const known = ['tide', 'lantern', 'murmuration', 'basin'];
    expect(rotationFromUrl('?rotate=20', known)?.ids).toEqual(['tide', 'lantern', 'murmuration']);
    expect(rotationFromUrl('?rotate=0.5&rotation=basin,nope,tide', known)).toMatchObject({ ids: ['basin', 'tide'], intervalMs: 30_000 });
    expect(rotationFromUrl('?rotate=20&rotation=tide', known)).toBeNull();
    expect(rotationFromUrl('?rotation=tide,lantern', known)).toBeNull();
    expect(rotationFromUrl('?rotate=-3', known)).toBeNull();
  });
});
