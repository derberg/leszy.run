import { createClient } from '@supabase/supabase-js'
import { sql } from 'drizzle-orm'
import { events, categories, participants, checkpoints, raceRuns, results, eventDocuments } from '../db/schema.js'

// Reverse sync: Supabase → local, for event CONFIG + results — so an event created/edited
// on ONE device (e.g. the Mac) shows up automatically on EVERY other device (e.g. a Pi)
// bound to the same Supabase project. This is the pull half of two-way sync; the push half
// (local → Supabase) already lives in supabase.js.
//
// Safety model (why this is safe without an updated_at cursor):
//   - Every pulled row is upserted by id with synced_at = now(), so the push worker (which
//     only pushes rows where synced_at IS NULL) never echoes it straight back. The
//     0010_sync_trigger PASSES THROUGH a SET synced_at change (OLD.synced_at != NEW.synced_at)
//     instead of resetting it to NULL, so no ping-pong.
//   - The ON CONFLICT DO UPDATE is GUARDED by "synced_at IS NOT NULL": a locally-dirty row
//     (a pending local edit whose synced_at the trigger reset to NULL) is NEVER clobbered by
//     the remote copy — the local change is pushed first, then re-pulled. Last-pushed wins,
//     and no unpushed local edit is ever lost.
//
// Excluded on purpose:
//   - checkpoint_observations — already reverse-synced live by the realtime subscription in
//     supabase.js; handling it here too would double-write.
//   - gate_crossings — raw, high-volume, device-local; other devices only need the derived
//     `results`, not the raw crossings.
//   - checkpoint_categories — not in the push SYNC_TABLES (no synced_at), so not reliably in
//     Supabase; nothing to pull.
//
// Limitation: deletes are NOT propagated (additive/update only) — same as checkinSync. A row
// deleted on one device lingers on the others until manually removed.
//
// Test-data quarantine: the edge-function suite (supabase/functions/tests/) runs against the
// SAME production Supabase project — there is no isolated test env. Its throwaway
// `events`/`participants` rows exist in Supabase for the length of a suite run, which is
// longer than this worker's 30 s poll, so a poll pulls them into every backend host's local
// DB. The suite deletes them from Supabase afterwards, but per the limitation above THAT
// DELETE NEVER REACHES US — the rows are stranded locally forever (observed: two
// `[e2e-test] roster test` events + participants, gone from Supabase, still local). So refuse
// to pull marker-tagged events at all, and cascade the refusal to everything hanging off them.

let supabase = null

// FK parents first so child inserts never fail on a missing parent.
const PULL_TABLES = [
  { name: 'events', table: events },
  { name: 'categories', table: categories },
  { name: 'participants', table: participants },
  { name: 'checkpoints', table: checkpoints },
  { name: 'race_runs', table: raceRuns },
  { name: 'results', table: results },
  { name: 'event_documents', table: eventDocuments },
]

const PAGE = 1000 // PostgREST hard-caps a response at 1000 rows — paginate with range()

// Must stay in sync with E2E_MARKER in supabase/functions/tests/helpers.js.
const E2E_MARKER = '[e2e-test]'

// Fresh per pull: ids of rows refused above, so children of a refused event are refused too.
export function newSkipSets() {
  return { events: new Set(), categories: new Set(), raceRuns: new Set() }
}

// True if this remote row is test junk — either marker-tagged itself, or descended from a row
// that was. PULL_TABLES is ordered parents-first, so the parent's id is already in `skip`.
export function isTestRow(name, remote, skip) {
  switch (name) {
    case 'events':
      return typeof remote.name === 'string' && remote.name.startsWith(E2E_MARKER)
    case 'categories':
    case 'participants':
    case 'checkpoints':
    case 'event_documents':
      return skip.events.has(remote.event_id)
    case 'race_runs':
      return skip.categories.has(remote.category_id)
    case 'results':
      return skip.raceRuns.has(remote.race_run_id)
    default:
      return false
  }
}

// Remember a refused row's id so its own children get refused on a later table.
export function rememberSkipped(name, remote, skip) {
  if (name === 'events') skip.events.add(remote.id)
  else if (name === 'categories') skip.categories.add(remote.id)
  else if (name === 'race_runs') skip.raceRuns.add(remote.id)
}

// [{ prop, name, dataType }] for every real column of a Drizzle table.
function columnMeta(table) {
  const cols = []
  for (const [prop, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && typeof col.name === 'string' && col.dataType) {
      cols.push({ prop, name: col.name, dataType: col.dataType })
    }
  }
  return cols
}

// Supabase row (snake_case, JSON values) → Drizzle values (camelCase props, Date for timestamps).
function toLocalRow(cols, remote) {
  const row = {}
  for (const { prop, name, dataType } of cols) {
    if (!(name in remote)) continue
    let v = remote[name]
    if (v !== null && v !== undefined && dataType === 'date') v = new Date(v)
    row[prop] = v
  }
  return row
}

export function initConfigSync(db) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('[ConfigSync] Supabase credentials not set — config reverse sync disabled')
    return
  }
  supabase = createClient(url, key)
  console.log('[ConfigSync] Config reverse sync enabled, polling every 30s')
  setInterval(() => pullConfig(db), 30_000)
  setTimeout(() => pullConfig(db), 8_000)
}

export async function pullConfig(db) {
  if (!supabase) return
  const skip = newSkipSets()
  for (const { name, table } of PULL_TABLES) {
    try {
      const cols = columnMeta(table)
      let offset = 0
      let examined = 0
      let skipped = 0
      for (;;) {
        const { data, error } = await supabase.from(name).select('*').range(offset, offset + PAGE - 1)
        if (error) { console.error(`[ConfigSync] fetch ${name}:`, error.message); break }
        if (!data?.length) break

        for (const remote of data) {
          if (!remote.id) continue
          if (isTestRow(name, remote, skip)) {
            rememberSkipped(name, remote, skip)
            skipped++
            continue
          }
          const now = new Date()
          const values = toLocalRow(cols, remote)
          values.syncedAt = now // never trust remote synced_at; stamp local so push won't echo

          const set = {}
          for (const { prop } of cols) {
            if (prop === 'id' || prop === 'syncedAt') continue
            if (prop in values) set[prop] = values[prop]
          }
          set.syncedAt = now

          try {
            await db.insert(table).values(values).onConflictDoUpdate({
              target: table.id,
              set,
              // Guard: only refresh a CLEAN local row. A dirty row (local edit not yet
              // pushed → synced_at NULL) is left untouched so the local change wins.
              setWhere: sql`${table.syncedAt} IS NOT NULL`,
            })
          } catch (e) {
            // Secondary unique constraints (e.g. categories(event_id, slug),
            // results(race_run_id, participant_id)) can collide when a row exists locally
            // under a different id. Log and skip that one row — never wedge the batch.
            console.error(`[ConfigSync] upsert ${name} ${remote.id}: ${e.message}`)
          }
        }

        examined += data.length
        if (data.length < PAGE) break
        offset += PAGE
      }
      if (examined) {
        const note = skipped ? ` (${skipped} test row(s) refused)` : ''
        console.log(`[ConfigSync] ${name}: examined ${examined} remote row(s)${note}`)
      }
    } catch (err) {
      console.error(`[ConfigSync] ${name}: ${err.message}`)
    }
  }
}
