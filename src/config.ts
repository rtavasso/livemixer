import { z } from 'zod';

export const STEMS = ['other', 'bass', 'drums', 'vocals'] as const;
export const RECIPES = ['sparse', 'pulse', 'open'] as const;
export type StemId = typeof STEMS[number];
export type RecipeId = typeof RECIPES[number];
export type GainDb = number | null;
const finite = z.number().finite();
const gain = finite.min(-120).max(0);
const asset = z.object({ file: z.string().min(1), trimDb: gain }).strict();
const gains = z.object({ other: gain.nullable().optional(), bass: gain.nullable().optional(), drums: gain.nullable().optional(), vocals: gain.nullable().optional() }).strict();
const approval = z.object({ recipes: z.boolean(), recipeTransitions: z.boolean(), loopSeam: z.boolean(), filterRange: z.boolean(), reviewedFingerprint: z.string().optional(), notes: z.string() }).strict();
export const controlSchema = z.object({
  smoothingMs: finite.positive().default(60), parameterRampMs: finite.positive().default(30),
  recipeDwellMs: finite.nonnegative().default(120), recipeRampMs: finite.positive().default(20),
  schedulerIntervalMs: finite.positive().default(25), lookaheadMs: finite.positive().default(150),
  minimumLeadMs: finite.positive().default(50), maxFrameAgeMs: finite.positive().default(200),
  lossHoldMs: finite.nonnegative().default(250), neutralReturnMs: finite.positive().default(1000),
  reacquireMs: finite.nonnegative().default(250), highThreshold: finite.min(0).max(1).default(.92),
  highHoldMs: finite.positive().default(1200), rearmThreshold: finite.min(0).max(1).default(.75),
  rearmMs: finite.positive().default(500), neutral: finite.min(0).max(1).default(.3),
}).strict();
export type ControlSettings = z.infer<typeof controlSchema>;
export const DEFAULT_CONTROL = controlSchema.parse({});
const sceneSchema = z.object({
  id: z.string().min(1), sourceSongId: z.string().min(1), label: z.string().min(1),
  sourceSampleRate: finite.int().min(8000).max(192000), sourceFrameCount: finite.int().positive(),
  loopBars: z.union([z.literal(4), z.literal(8)]), beatsPerBar: z.literal(4),
  nominalBpm: finite.positive().optional(), keyLabel: z.string().optional(),
  recipeQuantizationBars: finite.int().positive(), anchorStem: z.enum(STEMS),
  stems: z.object({ other: asset.optional(), bass: asset.optional(), drums: asset.optional(), vocals: asset.optional() }).strict(),
  recipes: z.object({ sparse: gains, pulse: gains, open: gains }).strict(),
  filter: z.object({ minHz: finite.positive(), maxHz: finite.positive(), q: finite.min(-20).max(30), target: z.enum(['anchor', 'instrumental']).optional() }).strict(),
  sceneTrimDb: gain, approval,
}).strict().superRefine((s, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!s.stems.other || !s.stems.bass || !s.stems.drums) fail('The other, bass, and drums stems are required.');
  if (!s.stems[s.anchorStem]) fail('Anchor stem is absent.');
  if (s.loopBars % s.recipeQuantizationBars !== 0) fail('Recipe grid must divide the loop.');
  if (s.filter.minHz >= s.filter.maxHz) fail('Filter minimum must be below maximum.');
  for (const r of RECIPES) {
    for (const stem of STEMS) {
      if (s.stems[stem] && s.recipes[r][stem] === undefined) fail(`${r} is missing ${stem} gain.`);
      if (!s.stems[stem] && s.recipes[r][stem] !== undefined) fail(`${r} mentions absent ${stem}.`);
    }
    if (s.recipes[r][s.anchorStem] == null) fail(`${r} mutes the anchor.`);
  }
  const vocal = RECIPES.map(r => s.recipes[r].vocals);
  if (s.stems.vocals && vocal.some(g => g === null) && vocal.some(g => g != null) && s.recipeQuantizationBars !== s.loopBars) fail('Recipes toggling vocals require a whole-loop grid.');
});
const edgeSchema = z.object({
  from: z.string(), to: z.string(), kind: z.literal('fade_to_zero_reset'), fadeOutBeats: z.literal(1),
  fadeInMs: finite.positive().max(100), approved: z.boolean(), reviewedFingerprint: z.string().optional(), notes: z.string(),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), label: z.string(), scenes: z.array(sceneSchema).min(1).max(50),
  path: z.array(z.string()).min(1).max(50), repeatPath: z.boolean(), edges: z.array(edgeSchema),
  masterTrimDb: gain, control: controlSchema.default({}),
}).strict().superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const ids = m.scenes.map(s => s.id);
  if (new Set(ids).size !== ids.length || new Set(m.path).size !== m.path.length) fail('Scene and path IDs must be unique.');
  if (m.path.length !== ids.length || m.path.some(id => !ids.includes(id))) fail('Path must include every scene exactly once.');
  const keys = m.edges.map(e => `${e.from}\0${e.to}`);
  if (new Set(keys).size !== keys.length) fail('Duplicate transition edge.');
  for (const e of m.edges) if (!ids.includes(e.from) || !ids.includes(e.to) || e.from === e.to) fail('Unresolved or self-referencing edge.');
  const count = m.path.length - 1 + (m.repeatPath ? 1 : 0);
  for (let i = 0; i < count; i++) {
    if (!m.edges.some(e => e.from === m.path[i] && e.to === m.path[(i + 1) % m.path.length])) fail('Every path step needs an explicit edge.');
  }
  if (m.control.lookaheadMs <= m.control.minimumLeadMs) fail('Lookahead must exceed minimum lead.');
  if (m.control.rearmThreshold >= m.control.highThreshold) fail('Rearm must be below the high threshold.');
  for (const s of m.scenes) if (m.control.recipeRampMs / 1000 >= s.sourceFrameCount / s.sourceSampleRate / s.loopBars * s.recipeQuantizationBars) fail('Recipe ramp must be shorter than its grid interval.');
});
export type Scene = z.infer<typeof sceneSchema>;
export type ResetEdge = z.infer<typeof edgeSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export function validateManifest(input: unknown): Manifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues.map(i => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('\n'));
  return result.data;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256(bytes: ArrayBuffer | string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function scenePlaybackConfig(scene: Scene) {
  const { approval: _approval, label: _label, keyLabel: _key, nominalBpm: _bpm, ...playback } = scene;
  return playback;
}
export async function sceneFingerprint(scene: Scene, hashes: Partial<Record<StemId, string>>, masterTrimDb: number, control: ControlSettings) {
  return sha256(stableJson({ audioGraphVersion: 'hand-space-instrumental-v2-safe-loops', scene: scenePlaybackConfig(scene), media: hashes, masterTrimDb, control }));
}
export async function edgeFingerprint(edge: ResetEdge, fingerprints: Record<string, string>) {
  const { approved: _approved, reviewedFingerprint: _fingerprint, notes: _notes, ...settings } = edge;
  return sha256(stableJson({ settings, from: fingerprints[edge.from], to: fingerprints[edge.to] }));
}
export function sceneApprovalError(scene: Scene, fingerprint: string): string | undefined {
  if (!scene.approval.recipes || !scene.approval.recipeTransitions || !scene.approval.loopSeam || !scene.approval.filterRange) return `${scene.label}: musical review is incomplete.`;
  if (scene.approval.reviewedFingerprint !== fingerprint) return `${scene.label}: approval is stale (media or playback settings changed).`;
}
export function edgeApprovalError(edge: ResetEdge, fingerprint: string): string | undefined {
  if (!edge.approved) return `${edge.from} → ${edge.to}: transition has not been approved.`;
  if (edge.reviewedFingerprint !== fingerprint) return `${edge.from} → ${edge.to}: transition approval is stale.`;
}
export const dbToGain = (db: GainDb): number => db === null ? 0 : 10 ** (db / 20);
