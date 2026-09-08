import { DEFAULT_CONTROL, validateManifest, type Manifest, type Scene } from '../src/config';
import type { PlannerEnvironment } from '../src/music/planner';
export function testScene(id = 'a'): Scene {
  return { id, sourceSongId: id, label: id, sourceSampleRate: 48000, sourceFrameCount: 384000, loopBars: 4, beatsPerBar: 4, nominalBpm: 120, recipeQuantizationBars: 1, anchorStem: 'other', stems: { other: { file: `${id}/other.wav`, trimDb: 0 }, bass: { file: `${id}/bass.wav`, trimDb: 0 }, drums: { file: `${id}/drums.wav`, trimDb: 0 } }, recipes: { sparse: { other: 0, bass: null, drums: null }, pulse: { other: 0, bass: -6, drums: -10 }, open: { other: 0, bass: -2, drums: -3 } }, filter: { minHz: 800, maxHz: 8000, q: 0 }, sceneTrimDb: -3, approval: { recipes: false, recipeTransitions: false, loopSeam: false, filterRange: false, notes: '' } };
}
export function testManifest(): Manifest {
  return validateManifest({ version: 1, label: 'Tests', scenes: [testScene(), { ...testScene('b'), sourceFrameCount: 460800 }], path: ['a', 'b'], repeatPath: false, edges: [{ from: 'a', to: 'b', kind: 'fade_to_zero_reset', fadeOutBeats: 1, fadeInMs: 10, approved: false, notes: '' }], masterTrimDb: -9, control: DEFAULT_CONTROL });
}
export function testEnvironment(): PlannerEnvironment { return { manifest: testManifest(), scenes: { a: { duration: 8 }, b: { duration: 9.6 } }, edgeErrors: {} }; }
