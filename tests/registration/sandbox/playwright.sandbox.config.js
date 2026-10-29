import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// The dpay sandbox acceptance suite (plan 3, task 10). Manual and nightly, never in PR CI. Without
// DPAY_ENV=sandbox every test is skipped with a reason. No webServer: the specs call the functions of the
// local Supabase stack and drive only dpay's own payment page in the browser.
export default defineConfig({
  testDir: here,
  testMatch: /acceptance\.spec\.js$/,
  outputDir: path.join(here, '../test-results/sandbox'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  reporter: [['list'], ['json', { outputFile: path.join(here, '../test-results/sandbox-report.json') }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
