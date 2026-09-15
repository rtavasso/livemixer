import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { installUploadTransport } from './fadr-transfer.mjs';

const run = promisify(execFile);
const extractor = fileURLToPath(new URL('./fadr-extract.py', import.meta.url));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function save(path, data) {
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
function child(root, path) {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Expected a file inside the playlist folder');
  return target;
}
async function until(check, timeout, label) {
  const end = Date.now() + timeout;
  let report = 0;
  while (Date.now() < end) {
    if (await check()) return;
    if (Date.now() > report) { console.log(label); report = Date.now() + 30_000; }
    await delay(1000);
  }
  throw new Error(`Timed out: ${label}`);
}
async function closeMenu(menu) {
  if (!await menu.count()) return;
  const mask = menu.locator('xpath=..').locator(':scope > .mask');
  if (await mask.count() !== 1) throw new Error('Fadr menu close control changed');
  await mask.click({ position: { x: 5, y: 5 } });
}

export async function importPlaylist(page, url, folder, stems = 'pro') {
  const parsed = new URL(url);
  const match = /^\/playlist\/([a-zA-Z0-9]{22})\/?$/.exec(parsed.pathname);
  if (parsed.hostname !== 'open.spotify.com' || !match) throw new Error('Expected a Spotify playlist URL');
  const output = resolve(folder, 'playlist.local.json');
  if (await exists(output)) throw new Error(`Playlist already exists: ${output}`);
  await page.goto(`https://open.spotify.com/embed/playlist/${match[1]}`, { waitUntil: 'domcontentloaded' });
  const data = JSON.parse(await page.locator('script#__NEXT_DATA__').textContent());
  const entity = data.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList?.length) throw new Error('Spotify did not expose a track list');
  // Spotify embeds can truncate long playlists. Never silently claim a complete import.
  if (entity.trackList.length >= 100) throw new Error('The embed may be truncated. Export the full playlist before continuing');
  const tracks = entity.trackList.map((track, index) => {
    if (!/^spotify:track:[a-zA-Z0-9]{22}$/.test(track.uri) || !track.title || !track.subtitle || !(track.duration > 0)) throw new Error('Unsupported Spotify track metadata');
    return { id: `${String(index + 1).padStart(2, '0')}-${track.uri.split(':').at(-1)}`, title: track.title,
      artist: track.subtitle, duration: track.duration / 1000, spotify: track.uri };
  });
  await mkdir(folder, { recursive: true });
  await save(output, { version: 1, name: entity.name, url, stems, tracks });
  console.log(`Imported ${tracks.length} tracks: ${output}`);
}

async function ready(page, pro) {
  const signingIn = /\/(login|signup)(\/|$)/.test(new URL(page.url()).pathname);
  if (!signingIn && new URL(page.url()).pathname !== '/stems') await page.goto('https://fadr.com/stems', { waitUntil: 'domcontentloaded' });
  // Allow hydration and account restoration before checking subscription controls.
  await delay(2000);
  if (!await page.locator('.page._stems input[type=file]').count()) {
    if (!/\/(login|signup)(\/|$)/.test(new URL(page.url()).pathname)) await page.goto('https://fadr.com/login', { waitUntil: 'domcontentloaded' });
    console.log('Sign in to Fadr in the browser window. Credentials stay in that browser.');
    await until(async () => !/\/(login|signup)(\/|\?|$)/.test(new URL(page.url()).pathname), 15 * 60_000, 'Waiting for Fadr login…');
    await page.goto('https://fadr.com/stems', { waitUntil: 'domcontentloaded' });
  }
  const toggle = page.locator('.page._stems > header button.switch').filter({ hasText: 'Pro' });
  await toggle.waitFor({ state: 'visible' });
  await until(() => toggle.isEnabled(), 30_000, 'Waiting for Fadr account…');
  if (Boolean(await toggle.locator('.switch-slider.on').count()) !== pro) await toggle.click();
  await until(async () => Boolean(await toggle.locator('.switch-slider.on').count()) === pro,
    15_000, pro ? 'Waiting for Pro mode; an existing Fadr Plus subscription is required…' : 'Selecting Basic mode…');
}

export async function splitPlaylist(page, manifestPath, { format = 'mp3', more = true, only, timeout = 20 * 60_000 } = {}) {
  if (!['mp3', 'wav'].includes(format)) throw new Error('Format must be mp3 or wav');
  manifestPath = resolve(manifestPath);
  const root = dirname(manifestPath), manifest = await readJSON(manifestPath);
  const audio = await readJSON(resolve(root, 'audio.local.json'));
  const submittedPath = resolve(root, 'uploads.local.json');
  const submitted = await exists(submittedPath) ? await readJSON(submittedPath) : {};
  const statePath = resolve(root, 'stems.local.json');
  const state = await exists(statePath) ? await readJSON(statePath) : {};
  const ids = manifest.tracks.map(track => track.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('Invalid or duplicate track IDs');
  if (only && !ids.includes(only)) throw new Error('Unknown track ID');
  const pro = manifest.stems === 'pro';
  let loggedIn = false, failures = 0;
  for (const track of manifest.tracks) {
    if (only && track.id !== only) continue;
    const source = audio[track.id];
    if (!source?.mp3 || source.error) { console.error(`Missing verified MP3: ${track.title}`); failures++; continue; }
    const mp3 = child(root, source.mp3), id = track.id;
    const hash = createHash('sha256').update(await readFile(mp3)).digest('hex');
    if (hash !== source.sha256) throw new Error(`Source changed: ${mp3}`);
    const record = state[id] ??= { sha256: hash, format, pro, more: pro && more, ...(submitted[id] ? { submitted: submitted[id] } : {}) };
    if (record.sha256 !== hash || record.format !== format || record.pro !== pro || record.more !== (pro && more)) throw new Error(`Source/export settings changed for ${id}; use a new playlist folder`);
    const archive = resolve(root, 'archives', `${id}.zip`), output = resolve(root, 'stems', id);
    try {
      console.log(`${id}: ${track.artist} — ${track.title}`);
      if (!await exists(archive)) {
        if (!loggedIn) { await ready(page, pro); loggedIn = true; }
        const heading = page.locator('.song-title h3').filter({ hasText: `[${id}]` });
        const card = page.locator('div.stems.song:has(> .song-header)').filter({ has: heading });
        if (!await card.count()) {
          const search = page.locator('.library-filters input[type=search]');
          if (await search.count()) {
            await search.fill(id);
            const item = page.locator('.song-preview[title]').filter({ hasText: `[${id}]` });
            await delay(1000);
            if (await item.count() === 1) await item.click();
            else if (await item.count() > 1) throw new Error('Multiple prior uploads match this track; resolve in Fadr');
            await search.fill('');
          }
          if (!await card.count()) {
            if (record.submitted) throw new Error('Prior upload not found. Open that song from your Fadr library, then retry to avoid uploading it twice');
            record.submitted = new Date().toISOString();
            await save(statePath, state);
            await page.locator('.page._stems .upload input[type=file]').setInputFiles(mp3);
          }
        }
        await until(async () => await card.count() === 1, 30_000, 'Waiting for the uploaded song…');
        const downloadMenu = card.locator('.actions .context-menu-container').filter({ has: page.locator('.download-remix-button') });
        let uploadRetries = 0;
        await until(async () => {
          if (await downloadMenu.count() === 1) return true;
          const httpError = card.locator('.actions button').filter({ hasText: /request failed with status code \d+/i });
          if (await httpError.count() === 1 && await httpError.isEnabled()) throw new Error(await httpError.innerText());
          const retry = card.locator('.actions button').filter({ hasText: /timeout(?: of \d+ms)? exceeded|network error|request aborted|try again/i });
          if (await retry.count() === 1 && await retry.isEnabled()) {
            if (uploadRetries++ >= 2) throw new Error('Fadr upload/split failed after two retries');
            const dismiss = page.getByRole('button', { name: 'Got it', exact: true });
            if (await dismiss.isVisible()) await dismiss.click();
            console.log('Retrying the failed Fadr upload/split…');
            await retry.click();
          }
          return false;
        }, timeout, 'Waiting for Fadr upload and splitting…');
        if (pro && more) {
          // Each action disappears when its child stems finish. New guitar options may appear afterward.
          for (let round = 0; round < 12; round++) {
            const moreButton = card.getByRole('button', { name: /^More Stems$/i });
            if (!await moreButton.count()) break;
            const menu = card.locator('.context-menu.more-stems');
            if (!await menu.count()) await moreButton.click();
            const options = menu.locator('button.context-menu-option');
            await options.first().waitFor();
            const labels = await options.evaluateAll(buttons => buttons.map(button => button.querySelector('span').textContent));
            for (const label of labels) {
              const option = options.filter({ hasText: label });
              // A resumed song can already have an additional split in progress.
              if (await option.count() && await option.isEnabled()) await option.click();
            }
            await until(async () => {
              for (const label of labels) if (await options.filter({ hasText: label }).count()) return false;
              return true;
            }, timeout, `Fadr: ${labels.join(', ')}…`);
            await closeMenu(menu);
            if (round === 11) throw new Error('Additional stem menu did not finish');
          }
        }
        const menu = downloadMenu.locator('.context-menu');
        if (!await menu.count()) await downloadMenu.locator('.download-remix-button').click();
        // Fadr snapshots this bank before additional splits finish. Changing modes
        // rebuilds it from the current stems, even when the menu was already open.
        const mode = menu.locator('button.toggle').filter({ hasText: 'Combine' });
        if (await mode.locator('._active').innerText() === 'Combine') await mode.click();
        await mode.click();
        await until(async () => await mode.locator('._active').innerText() === 'Combine', 5000, 'Refreshing available stems…');
        await mode.click();
        await until(async () => await mode.locator('._active').innerText() === 'Download', 5000, 'Selecting stem download…');
        const all = menu.locator('input#all');
        if (!await all.isChecked()) await menu.locator('label[title="Toggle all"]').click();
        record.roles = await menu.locator('.download-stems-bank label[title]').evaluateAll(labels =>
          labels.map(label => label.getAttribute('title').slice(7)).filter(role => role !== 'all'));
        if (pro && !record.roles.some(role => /piano/i.test(role))) throw new Error('Pro instrument stems are missing');
        if (pro && more && !['Lead Vocals', 'Background Vocals', 'Other Drums', 'Kick', 'Snare'].every(role => record.roles.includes(role))) {
          throw new Error('Additional vocal or drum stems are missing from the download bank');
        }
        const quality = menu.getByRole('button', { name: /mp3\s*wav/i });
        const wav = Boolean(await quality.locator('.switch-slider.on').count());
        if (wav !== (format === 'wav')) await quality.click();
        await save(statePath, state);
        const start = menu.locator('button.context-menu-option').filter({ has: page.locator('.icon.download') });
        const [download] = await Promise.all([page.waitForEvent('download', { timeout }), start.click()]);
        if (!/\.zip$/i.test(download.suggestedFilename())) throw new Error(`Expected a stem ZIP, got ${download.suggestedFilename()}`);
        await mkdir(dirname(archive), { recursive: true });
        await download.saveAs(`${archive}.partial`);
        await rename(`${archive}.partial`, archive);
        record.archive = relative(root, archive);
        await save(statePath, state);
        // Close only the current working card; the song remains in the Fadr library.
        await closeMenu(menu);
        await card.locator('button[title="Close stems"]').click();
      }
      const result = await run('python3', [extractor, archive, output, '--roles', ...(record.roles ?? [])]);
      record.output = relative(root, output);
      record.complete = new Date().toISOString();
      delete record.error;
      console.log(result.stdout.trim());
    } catch (error) {
      record.error = error.message;
      failures++;
      console.error(`${id}: ${error.message}`);
      // Avoid cascading uploads after a UI or account failure.
      await save(statePath, state);
      break;
    }
    await save(statePath, state);
  }
  const completed = manifest.tracks.filter(track => state[track.id]?.complete && !state[track.id]?.error).length;
  console.log(`Verified stem folders: ${completed}/${manifest.tracks.length}; errors this run: ${failures}`);
  return failures === 0 && (only ? Boolean(state[only]?.complete && !state[only]?.error) : completed === manifest.tracks.length);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    output: { type: 'string' }, profile: { type: 'string', default: '.fadr/browser' },
    format: { type: 'string', default: 'mp3' }, basic: { type: 'boolean', default: false },
    'six-only': { type: 'boolean', default: false }, only: { type: 'string' }, help: { type: 'boolean', default: false },
    'upload-transport': { type: 'string', default: 'browser' },
  } });
  const [command, input] = positionals;
  if (values.help || !['import', 'split', 'login'].includes(command) || (command !== 'login' && !input)) {
    console.log('Usage: npm run fadr -- import SPOTIFY_URL --output .fadr/my-playlist\n       npm run fadr -- split .fadr/my-playlist/playlist.local.json [--format mp3|wav] [--six-only] [--only TRACK_ID]\n       npm run fadr -- login');
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (command === 'import' && !values.output) throw new Error('Import requires --output');
  if (!['browser', 'curl'].includes(values['upload-transport'])) throw new Error('Upload transport must be browser or curl');
  const context = await chromium.launchPersistentContext(resolve(values.profile), {
    headless: false, acceptDownloads: true,
    ...(process.env.LIVEMIXER_BROWSER_EXECUTABLE ? { executablePath: process.env.LIVEMIXER_BROWSER_EXECUTABLE } : {}),
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    if (command === 'split' && values['upload-transport'] === 'curl') {
      const root = dirname(resolve(input));
      await installUploadTransport(page, await readJSON(resolve(root, 'audio.local.json')), root);
    }
    if (command === 'import') await importPlaylist(page, input, resolve(values.output), values.basic ? 'basic' : 'pro');
    if (command === 'login') await ready(page, !values.basic);
    if (command === 'split' && !await splitPlaylist(page, input, { format: values.format, more: !values['six-only'], only: values.only })) process.exitCode = 1;
  } finally { await context.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
