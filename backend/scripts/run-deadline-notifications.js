// Usage: cd backend && node --env-file=../.env scripts/run-deadline-notifications.js [--apply]
//
// Inserts 'deadline_soon' rows into event_notifications for active calendar
// events whose registration_deadline falls within the next 7 days. Range check
// (not equality) so a deadline ADDED 4 days out still fires. The UNIQUE
// (event_id, type) constraint makes re-runs idempotent.
// Dry run by default — use --apply to write.
import { createClient } from '@supabase/supabase-js'

const dryRun = !process.argv.includes('--apply')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

const today = new Date()
const plus7 = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)

const { data: candidates, error } = await supabase
  .from('calendar_events')
  .select('id, name, registration_deadline')
  .eq('status', 'active')
  .gte('registration_deadline', isoDate(today))
  .lte('registration_deadline', isoDate(plus7))
if (error) {
  console.error('query failed:', error.message)
  process.exit(1)
}

// Which already have a deadline_soon row? (candidate set is small, well under
// the PostgREST 1000-row cap)
const ids = (candidates ?? []).map((c) => c.id)
let have = new Set()
if (ids.length) {
  const { data: existing, error: exErr } = await supabase
    .from('event_notifications')
    .select('event_id')
    .eq('type', 'deadline_soon')
    .in('event_id', ids)
  if (exErr) {
    console.error('existing-notifications query failed:', exErr.message)
    process.exit(1)
  }
  have = new Set((existing ?? []).map((e) => e.event_id))
}

const missing = (candidates ?? []).filter((c) => !have.has(c.id))
console.log(`deadline within 7 days: ${ids.length} events, already notified: ${have.size}, to insert: ${missing.length}`)
for (const m of missing) {
  console.log(`  + ${m.registration_deadline}  ${m.name}`)
}

if (dryRun) {
  console.log('\nDRY RUN — nothing written. Use --apply to insert.')
  process.exit(0)
}

if (missing.length) {
  const { error: insErr } = await supabase
    .from('event_notifications')
    .insert(missing.map((c) => ({ event_id: c.id, type: 'deadline_soon' })))
  if (insErr) {
    console.error('insert failed:', insErr.message)
    process.exit(1)
  }
}
console.log(`inserted ${missing.length} deadline_soon notifications`)
