import { defineConfig, devices } from '@playwright/test'

// Runs against a running stack (docker compose in CI, or the dev server locally):
//   E2E_BASE_URL=http://localhost:3000 E2E_LOGIN=e2e E2E_PASSWORD=... pnpm e2e
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'on-first-retry' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
