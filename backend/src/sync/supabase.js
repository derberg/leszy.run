import { createClient } from '@supabase/supabase-js'
import { eq, isNull, isNotNull, inArray, and, sql, getTableColumns } from 'drizzle-orm'
import { events, categories, participants, raceRuns, gateCrossings, results,
         checkpoints, checkpointObservations, eventDocuments, teamLaps, hostTeams, teamBatons } from '../db/schema.js'
import { broadcast } from '../ws/broadcaster.js'
import { pushCheckpointLinks } from './checkpointLinks.js'
import { applyRemoteObservation, realtimeIo } from './realtimeObservations.js'

let supabase = null

const toSnake = (str) => str.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
// __xmin is our own optimistic-concurrency token (see markSynced) and is not a
// real column — it must never be sent to Supabase.
export const rowToSnake = (row) => Object.fromEntries(
  Object.entries(row).filter(([k]) => k !== '__xmin').map(([k, v]) => [toSnake(k), v])
)

// Columns Supabase owns: hosts never set them, they only ever pull them. A
// PostgREST upsert updates only the columns present in the payload, so leaving
// them out preserves Supabase's value. Sending them would let a participant row
// that went dirty on a host before Supabase set removed_at push removed_at = NULL
// and silently un-remove the runner. The pull (configSync) still maps them.
export const PUSH_EXCLUDED_COLUMNS = {
  events: ['club_id'],
  participants: ['registration_id', 'removed_at'],
}

// Payload for pushing one local row to Supabase table `name`.
export function toPushRow(name, row) {
  const snake = rowToSnake(row)
  for (const c of PUSH_EXCLUDED_COLUMNS[name] ?? []) delete snake[c]
  return snake
}

// Categories have a (event_id, slug) unique constraint in addition to id. If a category
// was recreated locally (new UUID, same slug), delete the stale Supabase row first.
// Not for a registration event (events.club_id set): Supabase's delete trigger refuses
// it, and the local routes refuse deleting its categories, so there is nothing stale to
// clear and the refused delete would only add noise every cycle.
export async function deleteStaleCategories(client, db, snakeRows) {
  const eventIds = [...new Set(snakeRows.map((r) => r.event_id).filter(Boolean))]
  if (!eventIds.length) return
  const registration = new Set((await db.select({ id: events.id }).from(events)
    .where(and(inArray(events.id, eventIds), isNotNull(events.clubId)))).map((r) => r.id))
  for (const row of snakeRows) {
    if (registration.has(row.event_id)) continue
    const { error } = await client.from('categories').delete()
      .eq('event_id', row.event_id).eq('slug', row.slug).neq('id', row.id)
    if (error) console.error(`[Sync] stale category cleanup for ${row.id}: ${error.message}`)
  }
}

// LOST UPDATE GUARD.
//
// The push worker snapshots dirty rows, spends a second or two upserting them to
// Supabase, then marks them synced. Marking by id alone loses any local change
// that landed in between: Supabase holds the pre-change value, the row is flagged
// clean so the push worker will never look at it again, and configSync — whose
// only protection is "don't touch locally-dirty rows" — then overwrites the local
// value with the stale remote copy.
//
// That is not theoretical. On 2026-08-07 it wiped the chip start_time of 3 of 19
// runners mid-race: their starts were confirmed at 14:53:27, the snapshot had been
// taken at 14:53:25, and a configSync pull reverted start_time to NULL at
// 14:53:55 — 0.7 s before their finish reads, which then credited them gun time
// instead of their real netto.
//
// Fix: stamp only if the row has not been modified since the snapshot, using
// Postgres's xmin system column (the xid of the last transaction to write the
// row) as a version token. No schema change, works on every table. A row that
// changed keeps synced_at NULL and is simply re-pushed on the next cycle with its
// current value — which is exactly the desired behaviour.
async function markSynced(db, table, rows, now) {
  let stamped = 0
  for (const row of rows) {
    const res = await db.update(table)
      .set({ syncedAt: now })
      .where(sql`id = ${row.id} AND xmin::text = ${row.__xmin}`)
      .returning({ id: table.id })
    if (res.length) stamped += 1
  }
  return stamped
}

// Tables whose batch push falls back to one row at a time on a unique violation:
// - checkpoint_observations has UNIQUE(checkpoint_id, bib_number) in Supabase (migration
//   20260727173000) besides the id: the checkpoint agent or a volunteer may have inserted the
//   pair first under a different id.
// - team_batons has UNIQUE (event_id, epc) DEFERRABLE INITIALLY DEFERRED: a swap of two teams'
//   tags pushed in one batch is checked at commit and goes through; a batch that still fails
//   (e.g. a tag another host already holds) falls back so the other rows are pushed.
// Every other table keeps the all-or-nothing batch.
export const PER_ROW_FALLBACK = new Set(['checkpoint_observations', 'team_batons'])

/**
 * Pushes rows one at a time. A pushed row is stamped like a batch row (markSynced). A refused
 * row is left dirty and returned, so it is pushed again next cycle, except a checkpoint
 * observation refused on its (checkpoint_id, bib_number) pair, which is retired (see below).
 * @returns {Promise<Array<{ id: string, message: string }>>} the rows left dirty
 */
export async function pushRowsOneByOne(client, db, table, name, rows, snakeRows) {
  const now = new Date()
  const failed = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const { error } = await client.from(name).upsert(snakeRows[i], { onConflict: 'id' })
    if (error) {
      if (name === 'checkpoint_observations' && error.code === '23505') {
        // INVARIANT: the (checkpoint_id, bib_number) pair already exists remotely under a
        // different id ⇒ treat this local row as synced. First-observation-wins by design
        // (matches the checkpoint-agent's own uploader). Stamped unconditionally on purpose:
        // this row is being retired, not pushed, so a concurrent local edit must not keep it
        // dirty forever — the remote pair wins regardless of local changes.
        await db.update(table).set({ syncedAt: now }).where(sql`id = ${row.id}`)
        continue
      }
      console.error(`[Sync] Error syncing ${name} row ${row.id} (left dirty):`, error.message)
      failed.push({ id: row.id, message: error.message })
      continue
    }
    // Same lost-update guard as the batch path.
    await markSynced(db, table, [row], now)
  }
  return failed
}

// Dirty rows plus their xmin version token.
function selectDirty(db, table) {
  return db.select({ ...getTableColumns(table), __xmin: sql`xmin::text`.as('__xmin') })
    .from(table)
    .where(isNull(table.syncedAt))
}

const SYNC_TABLES = [
  { table: events, name: 'events' },
  { table: categories, name: 'categories' },
  { table: participants, name: 'participants' },
  { table: hostTeams, name: 'host_teams' },
  { table: teamBatons, name: 'team_batons' },
  { table: raceRuns, name: 'race_runs' },
  { table: gateCrossings, name: 'gate_crossings' },
  { table: results, name: 'results' },
  { table: teamLaps, name: 'team_laps' },
  { table: checkpoints, name: 'checkpoints' },
  { table: checkpointObservations, name: 'checkpoint_observations' },
  { table: eventDocuments, name: 'event_documents' },
]

export function initSupabaseSync(db) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.log('[Sync] Supabase credentials not set — sync disabled')
    return
  }

  supabase = createClient(url, key)
  console.log('[Sync] Supabase sync enabled, polling every 30s')

  subscribeRealtime(db)

  setInterval(() => runSync(db), 10_000)
  // Run once on startup after a short delay
  setTimeout(() => runSync(db), 5_000)
}

export async function syncDelete(tableName, id) {
  if (!supabase) return
  const { error } = await supabase.from(tableName).delete().eq('id', id)
  if (error) console.error(`[Sync] Delete error on ${tableName}:`, error.message)
}

export async function syncDeleteEvent(eventId) {
  if (!supabase) return
  try {
    const { data: cats } = await supabase.from('categories').select('id').eq('event_id', eventId)
    const catIds = (cats || []).map(c => c.id)

    if (catIds.length) {
      const { data: rrs } = await supabase.from('race_runs').select('id').in('category_id', catIds)
      const rrIds = (rrs || []).map(r => r.id)
      if (rrIds.length) {
        await supabase.from('results').delete().in('race_run_id', rrIds)
        await supabase.from('gate_crossings').delete().in('race_run_id', rrIds)
        await supabase.from('race_runs').delete().in('id', rrIds)
      }
    }

    const { data: cps } = await supabase.from('checkpoints').select('id').eq('event_id', eventId)
    const cpIds = (cps || []).map(c => c.id)
    if (cpIds.length) {
      await supabase.from('checkpoint_observations').delete().in('checkpoint_id', cpIds)
      await supabase.from('checkpoint_categories').delete().in('checkpoint_id', cpIds)
      await supabase.from('checkpoints').delete().in('id', cpIds)
    }

    // Delete checkin-related data
    const { data: cks } = await supabase.from('checkins').select('id').eq('event_id', eventId)
    const ckIds = (cks || []).map(c => c.id)
    if (ckIds.length) {
      await supabase.from('checkin_documents').delete().in('checkin_id', ckIds)
      await supabase.from('checkins').delete().in('id', ckIds)
    }
    await supabase.from('event_documents').delete().eq('event_id', eventId)

    await supabase.from('participants').delete().eq('event_id', eventId)
    await supabase.from('categories').delete().eq('event_id', eventId)
    await supabase.from('events').delete().eq('id', eventId)
  } catch (err) {
    console.error('[Sync] Error cascading delete for event:', err.message)
  }
}

function subscribeRealtime(db) {
  const io = realtimeIo(db, broadcast)
  supabase
    .channel('leszyrun-realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
      (payload) => applyRemoteObservation(payload.new, 'INSERT', io),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'checkpoint_observations' },
      (payload) => applyRemoteObservation(payload.new, 'UPDATE', io),
    )
    .subscribe((status) => {
      console.log(`[Sync] Realtime subscription status: ${status}`)
    })
}

async function isOnline() {
  try {
    const url = process.env.SUPABASE_URL
    const res = await fetch(`${url}/rest/v1/`, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
    return res.ok || res.status === 401
  } catch {
    return false
  }
}

async function runSync(db) {
  const online = await isOnline()

  let pendingCount = 0
  for (const { table } of SYNC_TABLES) {
    const rows = await db.select({ count: sql`count(*)` }).from(table).where(isNull(table.syncedAt))
    pendingCount += Number(rows[0].count)
  }

  broadcast('sync:status', {
    status: online ? 'online' : 'offline',
    pendingCount,
    lastCheckedAt: new Date().toISOString(),
  })

  if (!online || pendingCount === 0) return

  console.log(`[Sync] Online. Syncing ${pendingCount} pending records...`)

  const syncErrors = []

  for (const { table, name } of SYNC_TABLES) {
    try {
      const rows = await selectDirty(db, table)
      if (!rows.length) continue

      const snakeRows = rows.map(r => toPushRow(name, r))

      if (name === 'categories') await deleteStaleCategories(supabase, db, snakeRows)

      const { error } = await supabase.from(name).upsert(snakeRows, { onConflict: 'id' })
      if (error) {
        // A batch upsert is all or nothing, so one row refused by a unique constraint other
        // than the id would wedge every other pending row of the table forever. For the
        // tables in PER_ROW_FALLBACK, push row by row instead (pushRowsOneByOne).
        if (PER_ROW_FALLBACK.has(name) && error.code === '23505') {
          console.error(`[Sync] Batch upsert conflict on ${name} (${error.message}) — falling back to per-row upserts`)
          const failed = await pushRowsOneByOne(supabase, db, table, name, rows, snakeRows)
          for (const f of failed) syncErrors.push(`${name} row ${f.id}: ${f.message}`)
          console.log(`[Sync] Per-row fallback complete for ${name}`)
          continue
        }

        console.error(`[Sync] Error syncing ${name}:`, error.message)
        syncErrors.push(`${name}: ${error.message}`)
        continue
      }

      // A checkpoint carries its category links (checkpointLinks.js). Replace them
      // before marking the rows synced, so a failure leaves them dirty for a retry.
      if (name === 'checkpoints') {
        const linkError = await pushCheckpointLinks(supabase, db, rows.map(r => r.id))
        if (linkError) {
          console.error('[Sync] Error syncing checkpoint_categories:', linkError)
          syncErrors.push(`checkpoint_categories: ${linkError}`)
          continue
        }
      }

      // Mark synced — only rows untouched since the snapshot (see markSynced).
      const now = new Date()
      const stamped = await markSynced(db, table, rows, now)
      const deferred = rows.length - stamped
      console.log(
        `[Sync] Synced ${stamped} rows from ${name}` +
        (deferred ? ` (${deferred} changed mid-push — left dirty, will re-push next cycle)` : '')
      )
    } catch (err) {
      console.error(`[Sync] Unexpected error for ${name}:`, err.message)
      syncErrors.push(`${name}: ${err.message}`)
    }
  }

  if (syncErrors.length) {
    broadcast('sync:status', {
      status: 'error',
      errors: syncErrors,
      pendingCount,
      lastCheckedAt: new Date().toISOString(),
    })
  }
}
