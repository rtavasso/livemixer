import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { curlUpload } from '../scripts/fadr-transfer.mjs';

test('upload transport sends the complete binary and preserves the storage response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fadr-transfer-'));
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const file = join(directory, 'audio with spaces.mp3');
  await writeFile(file, bytes);
  const received = [];
  let interrupted = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, type: request.headers['content-type'], origin: request.headers.origin, bytes: Buffer.concat(chunks) });
    response.setHeader('access-control-allow-origin', 'https://fadr.com');
    const timeout = request.url === '/interrupted' && interrupted++ < 1;
    response.writeHead(request.url === '/denied' ? 403 : timeout ? 400 : 200);
    response.end(request.url === '/denied' ? '<Error>Denied</Error>' : timeout ? '<Error><Code>RequestTimeout</Code></Error>' : '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await curlUpload(`${base}/upload`, file, { 'content-type': 'audio/mpeg', origin: 'https://fadr.com', 'content-length': '0' });
    assert.equal(result.status, 200);
    assert.equal(result.headers['access-control-allow-origin'], 'https://fadr.com');
    assert.equal(received[0].method, 'PUT');
    assert.equal(received[0].type, 'audio/mpeg');
    assert.deepEqual(received[0].bytes, bytes);
    const denied = await curlUpload(`${base}/denied`, file);
    assert.equal(denied.status, 403);
    assert.equal(denied.body, '<Error>Denied</Error>');
    assert.equal(received.length, 2, 'authorization failures are not retried');
    const retried = await curlUpload(`${base}/interrupted`, file);
    assert.equal(retried.status, 200);
    assert.equal(interrupted, 2);
    assert.deepEqual(received.at(-1).bytes, bytes);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
