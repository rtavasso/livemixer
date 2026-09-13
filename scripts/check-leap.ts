import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '10' }, profile: { type: 'string', default: 'responsive' } } });
const seconds = Number(values.seconds), profile = values.profile!;
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60 || !['responsive', 'bright-room', 'balanced'].includes(profile)) throw new Error('Use --seconds 1-60 and --profile responsive, bright-room or balanced.');
const child = spawn(process.env.LEAP_PYTHON ?? 'python', ['-u', fileURLToPath(new URL('./leap_bridge.py', import.meta.url)), '--seconds', String(seconds), '--profile', profile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const frames: { at: number; age: number; palms: number; fps: number | null }[] = [], health: Record<string, unknown>[] = [], errors: string[] = [];
const lines = createInterface({ input: child.stdout! });
lines.on('line', line => {
  try {
    const data = JSON.parse(line);
    if (data.type === 'frame') frames.push({ at: data.sentAtMs, age: data.ageMs, palms: data.palms.length, fps: data.trackingFps });
    if (data.type === 'health') { const { type: _type, sentAtMs: _at, ...value } = data; health.push(value); }
    if (data.type === 'error') errors.push(data.message);
  } catch { errors.push('Invalid reader output.'); }
});
child.stderr.on('data', () => {});
const timeout = setTimeout(() => child.kill(), (seconds + 8) * 1000);
const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }).finally(() => { clearTimeout(timeout); lines.close(); });
if (code !== 0 || errors.length || !frames.length) throw new Error(errors.join('; ') || 'No tracking frames received. Check the sensor/service connection.');
const ages = frames.map(f => f.age).sort((a, b) => a - b), gaps = frames.slice(1).map((f, i) => f.at - frames[i].at);
const result = {
  capturedAt: new Date().toISOString(), seconds, profile, frames: frames.length,
  receivedFps: frames.length > 1 ? (frames.length - 1) * 1000 / (frames.at(-1)!.at - frames[0].at) : 0,
  medianAgeMs: ages[Math.floor(ages.length / 2)], p95AgeMs: ages[Math.floor((ages.length - 1) * .95)], maxGapMs: Math.max(0, ...gaps),
  framesOver200Ms: ages.filter(age => age > 200).length, framesWithHands: frames.filter(f => f.palms > 0).length,
  health: health.at(-1), note: 'Captures timing/status metrics only; no images or palm coordinates. No-hand measurements do not establish moving-hand detection accuracy.',
};
await mkdir('test-results', { recursive: true });
await writeFile('test-results/leap-health.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
