import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localEnv } from './helpers/stack.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = localEnv()

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  globalSetup: path.join(here, 'e2e/global-setup.js'),
  use: { baseURL: 'http://localhost:5174' },
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    cwd: path.join(here, '../../public'),
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: env.url,
      VITE_SUPABASE_ANON_KEY: env.anonKey,
    },
  },
})
