import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4178', headless: true },
  workers: 1,
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4178', reuseExistingServer: !process.env.CI },
  reporter: [['list'], ['json', { outputFile: 'test-results/browser.json' }]],
});
