import { defineConfig } from 'vitest/config';
import { leapPlugin } from './scripts/leap-plugin';
export default defineConfig({
  plugins: [leapPlugin()],
  server: { port: 4178, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
});
