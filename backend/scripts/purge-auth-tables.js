// Usage: cd backend && node --env-file=../.env scripts/purge-auth-tables.js [--apply]
//
// Nothing ever deleted from auth_codes, auth_sessions or otp_throttle. Expired
// rows cannot authenticate — getSession checks expires_at — so this is not a
// hole, but every session token and every code hash ever issued accumulated
// forever, which widens the blast radius of any future disclosure of that
// database and slowly degrades the login-path lookups. auth_sessions also holds
// the plaintext email of accounts that have since been deleted.
//
// Dry run by default. The scheduler runs it with --apply daily; see
// scheduler/src/index.js.

import { createClient } from '@supabase/supabase-js'

const dryRun = !process.argv.includes('--apply')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

// A session is dead the moment it expires; the week of grace is only so a
// support question ("was I logged in on Tuesday?") is still answerable.
// A code is single-use and lives ten minutes, so a day is generous.
// A throttle window is 15 minutes, so a day is very generous.
const TARGETS = [
  { table: 'auth_sessions', column: 'expires_at', cutoff: daysAgo(7) },
  { table: 'auth_codes', column: 'expires_at', cutoff: daysAgo(1) },
  { table: 'otp_throttle', column: 'window_started_at', cutoff: daysAgo(1) },
]

let failed = false

for (const { table, column, cutoff } of TARGETS) {
  const { count, error: countErr } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .lt(column, cutoff)
  if (countErr) {
    console.error(`${table}: count failed: ${countErr.message}`)
    failed = true
    continue
  }

  console.log(`${table}: ${count ?? 0} row(s) with ${column} < ${cutoff}`)
  if (dryRun || !count) continue

  const { error } = await supabase.from(table).delete().lt(column, cutoff)
  if (error) {
    console.error(`${table}: delete failed: ${error.message}`)
    failed = true
    continue
  }
  console.log(`${table}: deleted ${count}`)
}

console.log(dryRun ? '\nDRY RUN — nothing deleted. Use --apply.' : '\ndone')
process.exit(failed ? 1 : 0)
