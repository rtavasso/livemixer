import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
// Run against npm run preview. This deliberately exercises built worker URLs.
const url = process.argv[2] ?? 'http://127.0.0.1:4179';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (new URL(r.url()).origin !== new URL(url).origin) external.push(r.url()); });
  await page.goto(new URL('/?fixtures=1&tools=1', url).href); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click(); await expect(page.locator('#context-state')).toHaveText('Audio running'); await page.locator('#stop').click();
  await page.locator('#play-mode').selectOption('space'); await page.locator('#start').click();
  await page.locator('#space-height').fill('0.9'); await page.locator('#space-depth').fill('0.9');
  await expect(page.locator('#space-sound')).toHaveText('Echoes & cloud'); await page.locator('#stop-all').click();
  let leap = 'not requested';
  if (process.argv.includes('--leap')) {
    await page.locator('#space-input').selectOption('leap'); await page.locator('#leap-connect').click();
    await expect(page.locator('#leap-status')).toContainText('Leap is', { timeout: 15000 });
    leap = await page.locator('#leap-status').innerText(); await page.locator('#leap-disconnect').click();
  }
  await page.locator('#setup-tab').click(); await page.locator('#library-fixtures').click(); await expect(page.locator('#song-list .song-card')).toHaveCount(2);
  await page.locator('#analyze-all').click();
  await expect(page.locator('#analysis-progress')).toContainText('Analysis complete', { timeout: 30000 });
  const worker = await page.evaluate(async () => {
    const worker = new Worker('/models/hand.worker.js');
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Model initialization timed out')); }, 30000);
      worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); if (data.type === 'ready') resolve('ready'); else reject(new Error(data.message)); };
      worker.postMessage({ type: 'init', wasmRoot: new URL('/models/wasm', location.href).href, modelUrl: new URL('/models/hand_landmarker.task', location.href).href });
    });
  });
  await mkdir('test-results', { recursive: true }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: 'test-results/production-library.png', fullPage: true });
  expect(worker).toBe('ready'); expect(errors).toEqual([]); expect(external).toEqual([]);
  const report = { browser: browser.version(), platform: process.platform, worker, leap, pageErrors: errors, externalRequests: external, productionLibraryAnalysis: 'passed', productionAudioStart: 'passed', productionHandSpace: 'passed' };
  await writeFile('test-results/production.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
