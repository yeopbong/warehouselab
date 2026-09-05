import { defineConfig, devices } from '@playwright/test';

const externalBaseURL = process.env.PW_BASE_URL;
const localBaseURL = `http://127.0.0.1:4173${process.env.VITE_BASE_PATH ?? '/'}`;
const baseURL = (externalBaseURL ?? localBaseURL).replace(/\/?$/, '/');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PW_CHANNEL,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --port 4173 --strictPort',
        url: localBaseURL,
        // An existing dev server must not silently turn production verification into dev-mode testing.
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
