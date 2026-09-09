/**
 * Capture a screenshot of every registered simulation (or one) driven by the
 * synthetic performer, for quick visual review without a camera.
 *
 *   npx tsx scripts/sim-screenshots.ts [--port 4190] [--sim basin] [--out shots] [--wait 6] [--quality medium]
 *
 * Starts a Vite dev server on the port when nothing answers there. Headless
 * Chromium renders WebGL through SwiftShader, so images show correctness and
 * mood, not performance.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { SIMULATIONS } from '../src/sim/host/registry';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '');
const port = Number(args.get('port') ?? 4190), out = args.get('out') ?? 'shots', waitSeconds = Number(args.get('wait') ?? 6), quality = args.get('quality') ?? 'medium';
const only = args.get('sim');
const base = `http://127.0.0.1:${port}`;

async function reachable(url: string) { try { const r = await fetch(url); return r.ok; } catch { return false; } }

let server: ChildProcess | undefined;
if (!(await reachable(`${base}/sim.html`))) {
  console.log(`Starting vite on ${port}…`);
  server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', env: { ...process.env, PORT: String(port) }, shell: process.platform === 'win32' });
  for (let i = 0; i < 60 && !(await reachable(`${base}/sim.html`)); i++) await new Promise(r => setTimeout(r, 500));
}
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  for (const sim of SIMULATIONS) {
    if (only && sim.id !== only) continue;
    await page.goto(`${base}/sim.html?source=synthetic&overlay=0&sim=${sim.id}&quality=${quality}&dpr=1`);
    await page.waitForFunction(() => !!window.livemixerSim?.host);
    await page.waitForTimeout(waitSeconds * 1000);
    const file = join(out, `${sim.id}.png`);
    await page.screenshot({ path: file });
    const state = await page.evaluate(() => { const s = window.livemixerSim.host.state(); return { warnings: s.warnings.map(w => w.message), signals: s.signals, perf: s.perf }; });
    console.log(`${sim.id.padEnd(9)} → ${file}  ${Object.entries(state.signals).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}${state.warnings.length ? `\n  warnings: ${state.warnings.join(' | ')}` : ''}`);
  }
  if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
} finally {
  await browser.close();
  server?.kill();
}
