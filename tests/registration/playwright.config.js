import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localEnv } from './helpers/stack.js'
import { VITE_BASE_PORT, slotPort, testSlot } from './helpers/slot.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = localEnv()
// 5174 in slot 0, 5174 + n x 100 in slot n (REG_TEST_SLOT). The /edge proxy in
// public/vite.config.js targets VITE_SUPABASE_URL, which is the slot's API.
const port = slotPort(VITE_BASE_PORT)
const baseURL = `http://localhost:${port}`
const slot = testSlot()

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  ...(slot === 0 ? {} : { outputDir: path.join(here, `test-results/slot-${slot}`) }),
  globalSetup: path.join(here, 'e2e/global-setup.js'),
  use: { baseURL },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    cwd: path.join(here, '../../public'),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: env.url,
      VITE_SUPABASE_ANON_KEY: env.anonKey,
      // The local switch for Plan 7's money features (flags.js moneyFeaturesLive, public/src/lib/moneyFeatures.js),
      // consulted only while PAID_REGISTRATION_ENABLED is false; pricing-transfer's V-90 test proves the off header is ignored.
      REGISTRATION_MONEY_TEST: 'on',
    },
  },
})
