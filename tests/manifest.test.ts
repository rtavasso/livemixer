import { describe, expect, it } from 'vitest';
import { edgeApprovalError, edgeFingerprint, sceneApprovalError, sceneFingerprint, validateManifest } from '../src/config';
import { validateDecoded, wavMetadata } from '../src/audio/assets';
import { testManifest } from './helpers';
describe('manifest validation', () => {
  it('accepts the complete instrumental contract and retains false approval', () => { expect(validateManifest(testManifest()).scenes[0].approval.recipes).toBe(false); });
  it.each(['missing gain', 'absent stem', 'muted anchor', 'positive trim', 'invalid filter', 'bad length', 'bad grid', 'bad path', 'nonfinite', 'missing edge', 'duplicate path'])('rejects %s', problem => {
    const m = testManifest(), s = m.scenes[0];
    if (problem === 'missing gain') delete s.recipes.open.drums;
    if (problem === 'absent stem') s.recipes.open.vocals = -8;
    if (problem === 'muted anchor') s.recipes.sparse.other = null;
    if (problem === 'positive trim') s.stems.bass!.trimDb = 1;
    if (problem === 'invalid filter') s.filter.maxHz = 100;
    if (problem === 'bad length') s.sourceFrameCount = 0;
    if (problem === 'bad grid') s.recipeQuantizationBars = 3;
    if (problem === 'bad path') m.path[0] = 'missing';
    if (problem === 'nonfinite') s.filter.q = Infinity;
    if (problem === 'missing edge') m.edges = [];
    if (problem === 'duplicate path') m.path = ['a', 'a'];
    expect(() => validateManifest(m)).toThrow();
  });
  it('enforces whole vocal phrase boundaries', () => {
    const m = testManifest(), s = m.scenes[0]; s.stems.vocals = { file: 'v.wav', trimDb: 0 };
    s.recipes.sparse.vocals = s.recipes.pulse.vocals = null; s.recipes.open.vocals = -8;
    expect(() => validateManifest(m)).toThrow(/vocals/); s.recipeQuantizationBars = 4; expect(() => validateManifest(m)).not.toThrow();
  });
  it('requires an explicit repeat edge', () => { const m = testManifest(); m.repeatPath = true; expect(() => validateManifest(m)).toThrow(/edge/); });
});
it('invalidates scene and edge approval after media/config changes but not notes', async () => {
  const m = testManifest(), s = m.scenes[0], hashes = { other: 'a', bass: 'b', drums: 'c' };
  const fingerprint = await sceneFingerprint(s, hashes, m.masterTrimDb, m.control);
  s.approval = { recipes: true, recipeTransitions: true, loopSeam: true, filterRange: true, notes: 'Reviewed', reviewedFingerprint: fingerprint };
  expect(sceneApprovalError(s, fingerprint)).toBeUndefined();
  expect(await sceneFingerprint(s, hashes, m.masterTrimDb, m.control)).toBe(fingerprint);
  s.recipes.open.bass = -4; const changed = await sceneFingerprint(s, hashes, m.masterTrimDb, m.control);
  expect(sceneApprovalError(s, changed)).toMatch(/stale/);
  expect(await sceneFingerprint(s, { ...hashes, bass: 'new bytes' }, m.masterTrimDb, m.control)).not.toBe(changed);
  const e = m.edges[0], ef = await edgeFingerprint(e, { a: fingerprint, b: 'b' }); e.approved = true; e.reviewedFingerprint = ef;
  expect(edgeApprovalError(e, ef)).toBeUndefined(); expect(edgeApprovalError(e, await edgeFingerprint(e, { a: changed, b: 'b' }))).toMatch(/stale/);
});
it('compares source duration rather than resampled frame counts', () => {
  const scene = testManifest().scenes[0], decoded = { length: 352800, sampleRate: 44100 } as AudioBuffer;
  expect(validateDecoded(scene, [decoded, decoded, decoded])).toBe(8);
  expect(() => validateDecoded(scene, [decoded, { ...decoded, length: 352801 } as AudioBuffer])).toThrow(/different/);
  expect(() => validateDecoded(scene, [{ length: 100, sampleRate: 44100 } as AudioBuffer])).toThrow(/duration/);
});
it('rejects malformed WAV bytes before decode', () => { expect(() => wavMetadata(new ArrayBuffer(50))).toThrow(/WAV/); });
