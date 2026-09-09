/**
 * A dependency-free WebSocket server that receives the simulation telemetry
 * stream. Run it, point `sim.html?ws=ws://127.0.0.1:9000` at it, and watch
 * signals arrive; copy it as the starting point of the audio-mapping process,
 * or use any WebSocket library in any language instead (the protocol is JSON
 * text frames, see docs/SIMULATIONS.md).
 *
 *   npx tsx scripts/telemetry-sink.ts [port]
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface SinkClient { send(message: unknown): void; close(): void }
export interface SinkOptions { port: number; host?: string; onMessage?(message: unknown, client: SinkClient): void; onOpen?(client: SinkClient): void }
export interface TelemetrySink { server: Server; close(): Promise<void>; port: number }

/** Encode a server → client text frame (unmasked, per RFC 6455). */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}

/** Decode as many complete client → server frames as `buffer` holds. Returns the frames and the unconsumed remainder. */
export function decodeFrames(buffer: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset], second = buffer[offset + 1];
    const opcode = first & 0x0f, masked = (second & 0x80) !== 0;
    let length = second & 0x7f, headerLength = 2;
    if (length === 126) { if (buffer.length - offset < 4) break; length = buffer.readUInt16BE(offset + 2); headerLength = 4; }
    else if (length === 127) { if (buffer.length - offset < 10) break; length = Number(buffer.readBigUInt64BE(offset + 2)); headerLength = 10; }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - offset < headerLength + maskLength + length) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const payload = Buffer.alloc(length);
    buffer.copy(payload, 0, offset + headerLength + maskLength, offset + headerLength + maskLength + length);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    offset += headerLength + maskLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function createTelemetrySink(options: SinkOptions): Promise<TelemetrySink> {
  const server = createServer((_request, response) => { response.writeHead(426, { 'content-type': 'text/plain' }); response.end('This endpoint speaks WebSocket. Point sim.html?ws=ws://host:port at it.'); });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || (request.headers.upgrade ?? '').toLowerCase() !== 'websocket') { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending: Buffer = Buffer.alloc(0);
    const client: SinkClient = { send: message => { if (!socket.destroyed) socket.write(encodeTextFrame(JSON.stringify(message))); }, close: () => { if (!socket.destroyed) { socket.write(Buffer.from([0x88, 0])); socket.end(); } } };
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeFrames(pending); pending = Buffer.from(rest);
      for (const frame of frames) {
        if (frame.opcode === 1) { try { options.onMessage?.(JSON.parse(frame.payload.toString('utf8')), client); } catch { /* not JSON */ } }
        else if (frame.opcode === 8) { client.close(); }
        else if (frame.opcode === 9) { if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload])); }
      }
    });
    socket.on('error', () => socket.destroy());
    options.onOpen?.(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({ server, port, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 9000);
  let lastPrint = 0, frames = 0;
  const sink = await createTelemetrySink({
    port,
    onOpen: client => { console.log('page connected'); client.send({ type: 'get-schema' }); },
    onMessage: message => {
      const m = message as { type: string; [key: string]: unknown };
      if (m.type === 'schema') { const sim = m.sim as { title: string; signals: Record<string, { min: number; max: number; description: string }> }; console.log(`schema: ${sim.title}`); for (const [name, spec] of Object.entries(sim.signals)) console.log(`  ${name.padEnd(12)} [${spec.min}, ${spec.max}] ${spec.description}`); }
      else if (m.type === 'frame') {
        frames++;
        const now = Date.now();
        if (now - lastPrint > 1000) { lastPrint = now; const f = m as unknown as { sim: { signals: Record<string, number> }; input: { presence: number; hands: unknown[]; events: { type: string }[] } }; console.log(`${frames} frames · presence ${f.input.presence.toFixed(2)} · hands ${f.input.hands.length} · ${Object.entries(f.sim.signals).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ')}${f.input.events.length ? ` · events ${f.input.events.map(e => e.type).join(',')}` : ''}`); }
      } else if (m.type === 'status') console.log(`status: ${String(m.message)}`);
    },
  });
  console.log(`Telemetry sink listening on ws://127.0.0.1:${sink.port}. Open sim.html?ws=ws://127.0.0.1:${sink.port}`);
}
