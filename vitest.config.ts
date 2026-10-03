import { defineConfig } from 'vitest/config'

const integration = { testTimeout: 30_000, hookTimeout: 120_000 }

export default defineConfig({
  test: {
    // starts Postgres 18 + Redis 8 once for the whole run; URLs reach every project via provide/inject
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      { test: { name: 'db', root: './packages/db', environment: 'node', ...integration } },
      { test: { name: 'server', root: './packages/server', environment: 'node', ...integration } },
    ],
  },
})
