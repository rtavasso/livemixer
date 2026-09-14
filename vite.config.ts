import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { leapPlugin } from './scripts/leap-plugin';
// PORT lets a second checkout (or CI) run beside a dev server already on 4178.
const port = Number(process.env.PORT ?? 4178);
export default defineConfig({
  plugins: [leapPlugin()],
  server: { port, strictPort: true },
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('index.html', import.meta.url)), sim: fileURLToPath(new URL('sim.html', import.meta.url)), telemetry: fileURLToPath(new URL('telemetry.html', import.meta.url)) } } },
  test: { include: ['tests/**/*.test.ts'] },
});
