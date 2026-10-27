import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node apps/web/e2e/fixtures/server.mjs',
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node ../../node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
      cwd: 'apps/web',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
