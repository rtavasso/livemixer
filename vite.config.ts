import { defineConfig } from 'vitest/config';
export default defineConfig({
  server: { port: 4178, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
});
