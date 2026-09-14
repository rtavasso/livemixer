import { defineConfig } from '@playwright/test';
const port = Number(process.env.PORT ?? 4178);
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', timeout: 60_000,
  // Playwright empties its outputDir on every run; keep it away from other artifacts in test-results/.
  outputDir: 'test-results/playwright',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, launchOptions: process.env.LIVEMIXER_BROWSER_EXECUTABLE ? { executablePath: process.env.LIVEMIXER_BROWSER_EXECUTABLE } : {} },
  workers: 1,
  webServer: { command: 'npm run dev', url: `http://127.0.0.1:${port}`, reuseExistingServer: !process.env.CI, env: { PORT: String(port) } },
  reporter: [['list'], ['json', { outputFile: 'test-results/browser.json' }]],
});
