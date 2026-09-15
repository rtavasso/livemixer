import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const pattern = 'https://songtostems-songs.s3.us-east-1.amazonaws.com/**';

// This transports only the PUT already initiated by Fadr's upload control.
// The URL and headers are provided by the page, and are never logged.
async function curlAttempt(url, file, headers = {}) {
  const args = ['--silent', '--show-error', '--include', '--max-time', '180', '--request', 'PUT', '--data-binary', `@${file}`];
  for (const [name, value] of Object.entries(headers)) {
    if (!['content-length', 'host'].includes(name.toLowerCase())) args.push('--header', `${name}: ${value}`);
  }
  args.push('--write-out', '\nCODE=%{http_code}', '--url', url);
  let stdout;
  try { ({ stdout } = await exec('curl', args, { maxBuffer: 1024 * 1024 })); }
  catch (error) { throw Object.assign(new Error(`Storage upload failed (curl ${error.code ?? 'error'})`), { curlCode: error.code }); }
  const status = Number(/\nCODE=(\d+)\s*$/.exec(stdout)?.[1]);
  const raw = stdout.replace(/\nCODE=\d+\s*$/, '');
  // curl can print interim 100 Continue headers before the final response.
  const blocks = [...raw.matchAll(/HTTP\/[\d.]+ \d+[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/g)];
  const last = blocks.at(-1);
  if (!status || !last) throw new Error('Storage upload returned no HTTP response');
  const responseHeaders = Object.fromEntries(last[0].trim().split(/\r?\n/).slice(1).map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }).filter(([name]) => name));
  for (const name of ['transfer-encoding', 'connection', 'keep-alive']) delete responseHeaders[name];
  return { status, headers: responseHeaders, body: raw.slice(last.index + last[0].length) };
}

export async function curlUpload(url, file, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await curlAttempt(url, file, headers);
      if (attempt >= 2 || response.status !== 400 || !/<Code>RequestTimeout<\/Code>/.test(response.body)) return response;
    } catch (error) {
      if (attempt >= 2 || ![28, 52, 55, 56].includes(Number(error.curlCode))) throw error;
    }
    console.log('Retrying an interrupted storage transfer…');
    await delay(1000 * (attempt + 1));
  }
}

export async function installUploadTransport(page, audio, folder) {
  const root = resolve(folder);
  let active = 0;
  const waiting = [];
  const take = async () => { if (active >= 3) await new Promise(resolve => waiting.push(resolve)); else active++; };
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  await page.route(pattern, async route => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const id = Object.keys(audio).find(id => decodeURIComponent(new URL(request.url()).pathname).includes(id));
    if (!id) return route.fallback();
    await take();
    try {
      const file = resolve(root, audio[id].mp3), path = relative(root, file);
      if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Invalid source path');
      const bytes = await readFile(file);
      if (createHash('sha256').update(bytes).digest('hex') !== audio[id].sha256) throw new Error('Source changed');
      const response = await curlUpload(request.url(), file, await request.allHeaders());
      console.log(`Storage transfer ${id}: HTTP ${response.status}`);
      await route.fulfill(response);
    } catch (error) {
      console.error(`Storage transfer ${id}: ${error.message}`);
      await route.abort('failed').catch(() => {});
    } finally { release(); }
  });
}
