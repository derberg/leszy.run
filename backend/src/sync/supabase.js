import { createClient } from '@supabase/supabase-js'
import { eq, isNull, sql, getTableColumns } from 'drizzle-orm'
import { events, categories, participants, raceRuns, gateCrossings, results,
         checkpoints, checkpointObservations, eventDocuments } from '../db/schema.js'
import { broadcast } from '../ws/broadcaster.js'

let supabase = null

const toSnake = (str) => str.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
// __xmin is our own optimistic-concurrency token (see markSynced) and is not a
// real column — it must never be sent to Supabase.
const rowToSnake = (row) => Object.fromEntries(
  Object.entries(row).filter(([k]) => k !== '__xmin').map(([k, v]) => [toSnake(k), v])
)

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
  { table: raceRuns, name: 'race_runs' },
  { table: gateCrossings, name: 'gate_crossings' },
  { table: results, name: 'results' },
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

async function resolveParticipantId(db, remote) {
  const [cp] = await db.select({ eventId: checkpoints.eventId })
    .from(checkpoints)
    .where(eq(checkpoints.id, remote.checkpoint_id))
  if (!cp) return null
  const [found] = await db.select({ id: participants.id })
    .from(participants)
    .where(sql`event_id = ${cp.eventId} AND bib_number = ${remote.bib_number}`)
  return found ? found.id : null
}

function subscribeRealtime(db) {
  supabase
    .channel('leszyrun-realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
      async (payload) => {
        const remote = payload.new
        if (!remote?.id) return

        console.log(`[Sync] Realtime checkpoint_observation INSERT: bib ${remote.bib_number} (${remote.source})`)

        const participantId = await resolveParticipantId(db, remote)

        await db.insert(checkpointObservations)
          .values({
            id: remote.id,
            checkpointId: remote.checkpoint_id,
            bibNumber: remote.bib_number,
            participantId,
            observedAt: new Date(remote.observed_at),
            source: remote.source ?? 'manual',
            syncedAt: new Date(),
          })
          .onConflictDoNothing()

        // Broadcast to connected frontend clients
        broadcast('checkpoint:observation', {
          id: remote.id,
          checkpointId: remote.checkpoint_id,
          bibNumber: remote.bib_number,
          participantId,
          observedAt: remote.observed_at,
          source: remote.source ?? 'manual',
        })
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'checkpoint_observations' },
      async (payload) => {
        // The priority trigger upgrades a 'manual' row to 'rfid' in place (same
        // id) — that fires an UPDATE, not an INSERT, so the INSERT handler above
        // never sees it. Mirror the upgraded fields to the local row by id.
        const remote = payload.new
        if (!remote?.id) return

        console.log(`[Sync] Realtime checkpoint_observation UPDATE: bib ${remote.bib_number} (${remote.source})`)

        const participantId = await resolveParticipantId(db, remote)

        const [updated] = await db.update(checkpointObservations)
          .set({
            observedAt: new Date(remote.observed_at),
            source: remote.source ?? 'manual',
            participantId,
            syncedAt: new Date(),
          })
          .where(eq(checkpointObservations.id, remote.id))
          .returning({ id: checkpointObservations.id })

        // Local hadn't seen this row yet (missed INSERT / divergent id) → insert it.
        if (!updated) {
          await db.insert(checkpointObservations)
            .values({
              id: remote.id,
              checkpointId: remote.checkpoint_id,
              bibNumber: remote.bib_number,
              participantId,
              observedAt: new Date(remote.observed_at),
              source: remote.source ?? 'manual',
              syncedAt: new Date(),
            })
            .onConflictDoNothing()
        }

        broadcast('checkpoint:observation', {
          id: remote.id,
          checkpointId: remote.checkpoint_id,
          bibNumber: remote.bib_number,
          participantId,
          observedAt: remote.observed_at,
          source: remote.source ?? 'manual',
        })
      }
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

      const snakeRows = rows.map(rowToSnake)

      // Categories have a (event_id, slug) unique constraint in addition to id.
      // If a category was recreated locally (new UUID, same slug), delete the stale Supabase row first.
      if (name === 'categories') {
        for (const row of snakeRows) {
          await supabase.from('categories').delete()
            .eq('event_id', row.event_id).eq('slug', row.slug).neq('id', row.id)
        }
      }

      const { error } = await supabase.from(name).upsert(snakeRows, { onConflict: 'id' })
      if (error) {
        // checkpoint_observations has UNIQUE(checkpoint_id, bib_number) in Supabase
        // (migration 20260727173000) in addition to the id PK. If a local row's
        // (checkpoint_id, bib_number) pair already exists remotely under a
        // DIFFERENT id — the checkpoint-agent or a volunteer inserted that pair
        // first — the batched upsert 23505s on that one row and wedges every
        // other pending row in the same batch forever. Fall back to per-row
        // upserts so a single bad row can't block the rest. This fallback is
        // scoped to checkpoint_observations only; every other table keeps the
        // original all-or-nothing batch behavior.
        if (name === 'checkpoint_observations' && error.code === '23505') {
          console.error(`[Sync] Batch upsert conflict on ${name} (${error.message}) — falling back to per-row upserts`)
          const now = new Date()
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]
            const snakeRow = snakeRows[i]
            const { error: rowError } = await supabase.from(name).upsert(snakeRow, { onConflict: 'id' })
            if (rowError) {
              if (rowError.code === '23505') {
                // INVARIANT: the (checkpoint_id, bib_number) pair already exists
                // remotely under a different id ⇒ treat this local row as synced.
                // First-observation-wins by design (matches the checkpoint-agent's
                // own uploader) — the remote pair was recorded first, so this row
                // has nothing left to contribute; mark it synced so it stops
                // blocking future batches instead of retrying forever. Stamped
                // unconditionally on purpose: this row is being retired, not
                // pushed, so a concurrent local edit must not keep it dirty
                // forever — the remote pair wins regardless of local changes.
                await db.update(table).set({ syncedAt: now }).where(sql`id = ${row.id}`)
              } else {
                console.error(`[Sync] Error syncing ${name} row ${row.id}:`, rowError.message)
                syncErrors.push(`${name} row ${row.id}: ${rowError.message}`)
              }
              continue
            }
            // Same lost-update guard as the batch path: this row WAS pushed, so
            // only retire it if it hasn't changed since the snapshot.
            await markSynced(db, table, [row], now)
          }
          console.log(`[Sync] Per-row fallback complete for ${name}`)
          continue
        }

        console.error(`[Sync] Error syncing ${name}:`, error.message)
        syncErrors.push(`${name}: ${error.message}`)
        continue
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
