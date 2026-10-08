import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests of the running stack (docker compose up), in a real
 * browser at phone size. Phones are where the interface is tightest, so every
 * screen is exercised there first: a change to the interface comes with its
 * test here (docs/ARCHITECTURE.md, "End-to-end tests").
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  // One match is shared by the tests and they change it: one at a time, in order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'it-IT',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // A current Android phone and a small one: Chromium with touch and a phone viewport.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    {
      name: 'small-phone',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 640 } },
    },
  ],
})
