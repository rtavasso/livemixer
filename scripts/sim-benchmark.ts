/** Real display-cadence benchmark, with the renderer recorded in the report.
 * Start Vite, then: npm run benchmark:sim -- --port 4190 --seconds 20
 * Optional: --sim basin --quality low --width 1920 --height 1080 --out shots/run
 * --mixer loads the synthetic music fixtures and starts audio; --fullscreen
 * expands its player. Browser output is muted, but the audio graph runs.
 * --headless is a correctness run only; software GPUs are never labelled hardware.
 * --no-screenshot skips capture (useful when macOS stalls a fullscreen capture).
 * This measures delivered rAF cadence and CPU submission, not GPU execution time.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  args.set(key, process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? 'true' : process.argv[++i]);
}
const seconds = Number(args.get('seconds') ?? 20);
const width = Number(args.get('width') ?? 1280), height = Number(args.get('height') ?? 800);
const quality = args.get('quality') ?? 'medium', headless = args.has('headless');
const mixer = args.has('mixer');
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 300 || !Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100 || !['low', 'medium', 'high'].includes(quality)) throw new Error('Invalid duration, viewport, or quality.');
const out = args.get('out') ?? 'shots/benchmark';
const base = `http://127.0.0.1:${args.get('port') ?? 4190}`;
const sims = args.has('sim') ? [args.get('sim')!] : ['basin', 'veil', 'prism'];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless, args: ['--mute-audio'] });
const reports = [];
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  // tsx preserves nested function names with this esbuild helper. Playwright
  // serializes evaluate callbacks into the page, outside the module's scope.
  await page.addInitScript('globalThis.__name = value => value;');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  for (const sim of sims) {
    console.log(`Measuring ${sim} (${quality}, ${seconds}s after warmup)…`);
    const route = mixer ? '/?fixtures=1&play=simulation&' : '/sim.html?';
    await page.goto(`${base}${route}sim=${encodeURIComponent(sim)}&source=synthetic&overlay=0&quality=${quality}&dpr=2`);
    await page.waitForFunction(() => !!(window.livemixerSim?.host ?? window.livemixerPerformance?.simulation.player?.host)?.latestOutput);
    if (mixer) {
      await page.locator('#start').click();
      if (args.has('fullscreen')) await page.locator('#simulation-fullscreen').click();
    }
    await page.waitForTimeout(8000);
    const sample = await page.evaluate(async duration => {
      const host = window.livemixerSim?.host ?? window.livemixerPerformance.simulation.player!.host;
      const intervals: number[] = [], step: number[] = [], submit: number[] = [];
      let previous = 0, start = 0, droppedMs = 0;
      let previousOutput = host.latestOutput?.atMs, simulationFrames = 0, maxSimulationGapMs = 0;
      const signals: Record<string, [number, number]> = {};
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No visible animation frames during benchmark.')), duration + 15_000);
        const tick = (now: number) => {
          if (document.visibilityState !== 'visible') { clearTimeout(timeout); reject(new Error('Benchmark tab became hidden.')); return; }
          const firstFrame = !start;
          if (firstFrame) { start = now; previousOutput = host.latestOutput?.atMs; }
          if (previous) intervals.push(now - previous);
          previous = now;
          const s = host.state();
          step.push(s.perf.stepMs); submit.push(s.perf.renderMs);
          // The mixer can suspend its player while the window keeps receiving
          // animation frames. Count each published output and its dropped time
          // once; stale perf snapshots must not multiply a single stall.
          const outputAt = host.latestOutput?.atMs;
          if (!firstFrame && outputAt !== undefined && outputAt !== previousOutput) {
            if (previousOutput !== undefined) maxSimulationGapMs = Math.max(maxSimulationGapMs, outputAt - previousOutput);
            previousOutput = outputAt; simulationFrames++; droppedMs += s.perf.droppedMs;
          }
          for (const [k, v] of Object.entries(s.signals)) {
            const range = signals[k] ?? [v, v]; range[0] = Math.min(range[0], v); range[1] = Math.max(range[1], v); signals[k] = range;
          }
          if (now - start >= duration) { clearTimeout(timeout); resolve(); } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const elapsed = intervals.reduce((a, b) => a + b, 0);
      const percentile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]; };
      const s = host.state();
      const engine = window.livemixerPerformance?.engine();
      let audio = null;
      if (engine) {
        const samples = new Float32Array(512); engine.meter.getFloatTimeDomainData(samples);
        audio = { state: engine.context.state, running: window.livemixerPerformance.session()!.state.running,
          rms: Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length) };
      }
      return { sim: s.simulation.id, renderer: s.gpu, resolution: [s.width, s.height], elapsedMs: elapsed, frames: intervals.length,
        fps: intervals.length / elapsed * 1000, frameMs: { p50: percentile(intervals, .5), p95: percentile(intervals, .95), p99: percentile(intervals, .99) },
        simulationFrames, simulationFps: simulationFrames / elapsed * 1000, maxSimulationGapMs,
        cpuMs: { stepP95: percentile(step, .95), submitP95: percentile(submit, .95) }, droppedMs,
        audio, signals, warnings: s.warnings.map(w => w.message), violations: s.signalViolations };
    }, seconds * 1000);
    const hardware = !/swiftshader|llvmpipe|software|lavapipe/i.test(sample.renderer) && !headless;
    const report = { ...sample, hardware, mixer, quality, viewport: [width, height], browser: browser.version(), timestamp: new Date().toISOString() };
    reports.push(report);
    // Preserve completed measurements even if browser image capture fails.
    await writeFile(join(out, 'results.json'), JSON.stringify({ reports, errors }, null, 2) + '\n');
    console.log(JSON.stringify(report));
    if (!hardware) console.log('Software/headless result: do not use this as evidence of Intel GPU performance.');
    if (sample.sim !== sim || sample.warnings.length || sample.violations.length || errors.length) throw new Error('Simulation reported an error; see results.json.');
    if (!sample.simulationFrames) throw new Error('Simulation did not publish during the sample; see results.json.');
    if (mixer && (!sample.audio?.running || sample.audio.state !== 'running' || sample.audio.rms <= .0001)) throw new Error('Mixer audio did not run; see results.json.');
    if (!args.has('no-screenshot')) await page.screenshot({ path: join(out, `${sim}.png`), scale: 'css', timeout: 10_000 });
  }
} finally { await browser.close(); }
