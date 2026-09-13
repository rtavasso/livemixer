import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';

// Native IPC stays behind the app's localhost origin. No extra exposed port or SDK downloads.
export function leapPlugin(): Plugin {
  const install = (server: ViteDevServer | PreviewServer) => {
    let child: ChildProcess | undefined;
    let profile = 'responsive';
    let lastHealth: unknown, lastStatus: unknown;
    const clients = new Set<ServerResponse>();
    const send = (value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value) {
        if (value.type === 'health') lastHealth = value;
        if (value.type === 'status') lastStatus = value;
      }
      const message = `data: ${JSON.stringify(value)}\n\n`;
      for (const client of clients) {
        // Do not accumulate stale hand frames behind a slow/disconnected browser.
        if (client.writableLength > 65536) client.destroy(); else client.write(message);
      }
    };
    const stop = () => { const previous = child; child = undefined; lastHealth = lastStatus = undefined; previous?.kill(); };
    server.httpServer?.on('close', () => { for (const client of clients) client.end(); clients.clear(); stop(); });
    server.middlewares.use('/api/leap/events', (req, res) => {
      const host = req.headers.host ?? '';
      const allowedHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      const origin = req.headers.origin;
      if (req.method !== 'GET' || !allowedHost || (origin && origin !== `http://${host}` && origin !== `https://${host}`)) { res.statusCode = 403; res.end('Local same-origin requests only.'); return; }
      const requested = new URL(req.url ?? '', 'http://localhost').searchParams.get('profile') ?? 'responsive';
      if (!['responsive', 'bright-room', 'balanced'].includes(requested)) { res.statusCode = 400; res.end('Unknown tracking preset.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (child && profile !== requested) {
        res.end(`data: ${JSON.stringify({ type: 'error', message: 'Another Live Mixer tab is using a different Leap preset. Disconnect Leap there before changing presets.' })}\n\n`); return;
      }
      res.write(': connected\n\n'); clients.add(res);
      for (const value of [lastStatus, lastHealth]) if (value) res.write(`data: ${JSON.stringify(value)}\n\n`);
      res.on('close', () => { clients.delete(res); if (!clients.size) stop(); });
      if (child) return;
      profile = requested;
      const process = child = spawn(globalThis.process.env.LEAP_PYTHON ?? 'python', ['-u', fileURLToPath(new URL('./leap_bridge.py', import.meta.url)), '--profile', profile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = createInterface({ input: process.stdout! });
      lines.on('line', line => { if (child !== process) return; try { send(JSON.parse(line)); } catch { send({ type: 'error', message: 'Invalid response from the Leap reader.' }); } });
      process.stderr?.on('data', () => { /* Python errors are reported as structured stdout events. */ });
      process.on('error', () => { if (child === process) send({ type: 'error', message: 'Cannot start Python. Install 64-bit Python or set LEAP_PYTHON, then restart Live Mixer.' }); });
      process.on('close', () => {
        lines.close(); if (child !== process) return;
        child = undefined; send({ type: 'error', message: 'Leap reader stopped. Check its status above, then reconnect.' });
        for (const client of clients) client.end(); clients.clear();
      });
    });
  };
  return { name: 'local-leap-input', configureServer: install, configurePreviewServer: install };
}
