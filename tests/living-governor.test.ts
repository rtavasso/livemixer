import { describe, it, expect } from 'vitest';
import { AXES, Governor, HOME, isLivingSchema, toLiveControls, type Axes, type LivingSignals } from '../src/living/governor';

const DT = 1 / 30;
function run(governor: Governor, signals: LivingSignals | null, seconds: number): Axes {
  let axes = governor.value;
  for (let t = 0; t < seconds - 1e-9; t += DT) axes = governor.step(signals, DT);
  return axes;
}
const patient: LivingSignals = { presence: 1, reach: 1, lift: 1, closeness: 1, agitation: 0 };
const inRange = (axes: Axes) => AXES.every(key => Number.isFinite(axes[key]) && axes[key] >= 0 && axes[key] <= 1);

describe('living governor', () => {
  it('stays at home when nobody is present', () => {
    const g = new Governor();
    expect(run(g, { presence: 0, reach: 1, lift: 1, closeness: 1, agitation: 1 }, 10)).toEqual(HOME);
    expect(run(g, {}, 5)).toEqual(HOME);
    expect(run(g, null, 5)).toEqual(HOME);
  });

  it('moves slowly: a 100 ms spike of reach or agitation barely changes the sound', () => {
    const g = new Governor();
    run(g, { presence: 1, reach: 0, lift: .5, closeness: 0, agitation: 0 }, 3);
    const before = g.value;
    run(g, { presence: 1, reach: 1, lift: .5, closeness: 0, agitation: 0 }, .1);
    expect(g.value.depth - before.depth).toBeLessThan(.05);

    const h = new Governor();
    const settled = run(h, patient, 10);
    run(h, { ...patient, agitation: 1 }, .1);
    expect(settled.arrangement - h.value.arrangement).toBeLessThan(.03);
    expect(settled.space - h.value.space).toBeLessThan(.03);
    expect(settled.depth - h.value.depth).toBeLessThan(.05);
  });

  it('lets closeness gate how far the song leaves home', () => {
    const far = run(new Governor(), { ...patient, closeness: 0 }, 10);
    const near = run(new Governor(), patient, 10);
    expect(far.allowance).toBeCloseTo(.35);
    expect(near.allowance).toBeCloseTo(1);
    expect(far.arrangement).toBeCloseTo(.5 + .5 * .35, 2);
    expect(near.arrangement).toBeGreaterThan(.99);
    expect(far.depth).toBeCloseTo(.35, 2);
    expect(near.depth).toBeGreaterThan(.99);
    expect(far.space).toBe(0);
    expect(near.space).toBeGreaterThan(.9);
    const low = run(new Governor(), { ...patient, lift: 0 }, 10);
    expect(low.arrangement).toBeLessThan(.01);
  });

  it('pulls toward home when the visitor is agitated', () => {
    const calm = run(new Governor(), patient, 10);
    const wild = run(new Governor(), { ...patient, agitation: 1 }, 10);
    expect(wild.allowance).toBeCloseTo(.3);
    expect(wild.depth).toBeLessThan(calm.depth * .35);
    expect(Math.abs(wild.arrangement - .5)).toBeLessThan(Math.abs(calm.arrangement - .5) * .35);
    expect(wild.space).toBeLessThan(calm.space * .35);
  });

  it('opens vocals in under half a second and fades them over about 2.5 s after withdrawal', () => {
    const g = new Governor();
    expect(run(g, { presence: 1 }, .45).vocals).toBe(1);
    run(g, { presence: 0 }, 2);
    expect(g.value.vocals).toBeGreaterThan(.1);
    run(g, { presence: 0 }, 1);
    expect(g.value.vocals).toBe(0);
  });

  it('drifts every axis home over a few seconds when the hand leaves', () => {
    const g = new Governor();
    run(g, patient, 10);
    run(g, { ...patient, presence: 0 }, 1);
    expect(g.value.space).toBeGreaterThan(.3); // still a tail, not a dropout
    const home = run(g, { ...patient, presence: 0 }, 25);
    expect(home).toEqual(HOME);
  });

  it('release returns home at once', () => {
    const g = new Governor();
    run(g, patient, 10);
    expect(g.release()).toEqual(HOME);
    expect(g.value).toEqual(HOME);
  });

  it('stays within 0..1 for random and garbage input', () => {
    const g = new Governor();
    let seed = 7;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const junk = [NaN, Infinity, -Infinity, -5, 5, undefined, null, '1', {}];
    for (let i = 0; i < 5000; i++) {
      const pick = () => (random() < .2 ? junk[Math.floor(random() * junk.length)] : random() * 3 - 1) as number;
      const signals = { presence: pick(), reach: pick(), lift: pick(), closeness: pick(), agitation: pick() };
      const dt = random() < .05 ? (junk[Math.floor(random() * junk.length)] as number) : random() * .2;
      const axes = g.step(i % 97 === 0 ? (junk[i % junk.length] as unknown as LivingSignals) : signals, dt);
      expect(inRange(axes)).toBe(true);
      const live = toLiveControls(axes);
      expect([live.vocals, live.space, ...Object.values(live.fx)].every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const script = (g: Governor) => {
      const out: Axes[] = [];
      for (let i = 0; i < 600; i++) out.push(g.step({ presence: i > 30 && i < 400 ? 1 : 0, reach: (i % 90) / 90, lift: Math.sin(i / 40) * .5 + .5, closeness: Math.min(1, i / 300), agitation: i % 150 < 10 ? 1 : 0 }, DT));
      return out;
    };
    expect(script(new Governor())).toEqual(script(new Governor()));
  });

  it('maps axes to the bridge message with low echo and no one-shots', () => {
    const live = toLiveControls({ vocals: 1, arrangement: .7, depth: 1, space: 1, allowance: 1 });
    expect(live).toEqual({ type: 'controls', vocals: 1, space: .5, stutter: 0, gain: 1, fx: { flicker: 0, dub: .3, dive: .8, halo: .6, balance: .7 } });
    const home = toLiveControls(HOME);
    expect(home.fx).toEqual({ flicker: 0, dub: 0, dive: 0, halo: 0, balance: .5 });
    expect(home.space).toBe(0);
    expect(toLiveControls({ vocals: NaN, arrangement: NaN, depth: NaN, space: NaN, allowance: NaN }).fx.balance).toBe(.5);
  });

  it('recognises schemas that publish the living contract', () => {
    expect(isLivingSchema({ presence: {}, reach: {}, lift: {}, closeness: {}, agitation: {} })).toBe(true);
    expect(isLivingSchema({ presence: {}, reach: {} })).toBe(false);
    expect(isLivingSchema(undefined)).toBe(false);
  });
});
