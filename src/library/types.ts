import type { Scene, StemId } from '../config';
import type { WavInfo } from './wav';
export interface StemAnalysis { peakDbfs: number | null; rmsDbfs: number | null; crestDb: number; clippedSamples: number; nonfinite: number; dc: number; silentFraction: number; peaks: number[] }
export interface TempoEstimate { bpm: number | null; alternatives: number[]; strength: number; windowBpms: number[] }
export interface KeyEstimate { label: string; alternatives: string[]; separation: number; chroma: number[] }
export interface SongAnalysis { stems: Partial<Record<StemId, StemAnalysis>>; tempo: TempoEstimate; key: KeyEstimate; range: { start: number; duration: number }; version: number }
export interface LibrarySong {
  id: string; label: string; directory: string; files: File[];
  stems: Partial<Record<StemId, File>>; metadata: Partial<Record<StemId, WavInfo>>;
  issues: string[]; analysis?: SongAnalysis; signature: string;
  bpm?: number; key?: string; gridOffset: number; startBar: number; loopBars: 4 | 8; notes: string;
}
export interface LibraryClip { id: string; songId: string; scene: Scene; startFrame: number; files: Partial<Record<StemId, Blob>> }
