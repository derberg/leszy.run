// A scratch timing host for the registration tests: its own postgres:16 on
// 127.0.0.1:55432, migrated with the backend's Drizzle migrations, pulling from
// the LOCAL Supabase stack with the backend's pullConfig().
//
// Never initConfigSync() (it starts the 30 s poll timer, so node --test would
// never exit and pulls would race the assertions), and never the backend's
// db/index.js (it defaults to the Mac's real database on 5432). The database is
// this helper's own connection, and the Supabase client is built from
// localEnv(), which refuses anything that is not http://127.0.0.1.
//
// CI provides the postgres service on 55432 (.github/workflows/registration-tests.yml).
// Locally, when nothing answers on 55432, the helper starts a throwaway
// container and stop() removes it.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createClient } from '@supabase/supabase-js'
import { localEnv } from './stack.js'
import * as schema from '../../../backend/src/db/schema.js'
import { pullConfig } from '../../../backend/src/sync/configSync.js'

const SCRATCH_URL = process.env.SCRATCH_HOST_DATABASE_URL || 'postgres://leszyrun:leszyrun@127.0.0.1:55432/leszyrun'
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../backend/src/db/migrations')
const CONTAINER = 'leszyrun-hostpull-scratch'

function assertScratch(url) {
  const u = new URL(url)
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '55432') {
    throw new Error(`Refusing to run: the scratch host must be 127.0.0.1:55432, got ${u.hostname}:${u.port}`)
  }
}

async function reachable(url) {
  const probe = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} })
  try {
    await probe`select 1`
    return true
  } catch {
    return false
  } finally {
    await probe.end({ timeout: 1 })
  }
}

function startContainer() {
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', '127.0.0.1:55432:5432',
    '-e', 'POSTGRES_USER=leszyrun', '-e', 'POSTGRES_PASSWORD=leszyrun', '-e', 'POSTGRES_DB=leszyrun',
    'postgres:16'], { stdio: 'ignore' })
}

/** → { db, sql, pull(), stop() }. */
export async function startScratchHost() {
  assertScratch(SCRATCH_URL)
  const { url, serviceKey } = localEnv()
  let started = false
  if (!(await reachable(SCRATCH_URL))) {
    startContainer()
    started = true
    for (let i = 0; i < 60 && !(await reachable(SCRATCH_URL)); i++) await new Promise((r) => setTimeout(r, 500))
  }

  const sql = postgres(SCRATCH_URL, { max: 2, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  const client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  return {
    db,
    sql,
    /** One configSync poll from the local Supabase stack into the scratch database, quietly. */
    async pull() {
      const { log, error } = console
      const errors = []
      console.log = () => {}
      console.error = (...args) => errors.push(args.join(' '))
      try {
        await pullConfig(db, client)
      } finally {
        console.log = log
        console.error = error
      }
      return { errors }
    },
    async stop() {
      await sql.end({ timeout: 5 })
      if (started) execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' })
    },
  }
}
