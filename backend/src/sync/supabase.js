import { createClient } from '@supabase/supabase-js'
import { eq, isNull, sql } from 'drizzle-orm'
import { events, categories, participants, raceRuns, gateCrossings, results,
         checkpoints, checkpointObservations, eventDocuments } from '../db/schema.js'
import { broadcast } from '../ws/broadcaster.js'

let supabase = null

const toSnake = (str) => str.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const rowToSnake = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [toSnake(k), v]))

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

function subscribeRealtime(db) {
  supabase
    .channel('leszyrun-realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
      async (payload) => {
        const remote = payload.new
        if (!remote?.id) return

        console.log(`[Sync] Realtime checkpoint_observation: bib ${remote.bib_number}`)

        // Resolve participant_id from bib_number + event context
        const [cp] = await db.select({ eventId: checkpoints.eventId })
          .from(checkpoints)
          .where(eq(checkpoints.id, remote.checkpoint_id))

        let participantId = null
        if (cp) {
          const [found] = await db.select({ id: participants.id })
            .from(participants)
            .where(sql`event_id = ${cp.eventId} AND bib_number = ${remote.bib_number}`)
          if (found) participantId = found.id
        }

        await db.insert(checkpointObservations)
          .values({
            id: remote.id,
            checkpointId: remote.checkpoint_id,
            bibNumber: remote.bib_number,
            participantId,
            observedAt: new Date(remote.observed_at),
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
      const rows = await db.select().from(table).where(isNull(table.syncedAt))
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
        console.error(`[Sync] Error syncing ${name}:`, error.message)
        syncErrors.push(`${name}: ${error.message}`)
        continue
      }

      // Mark synced
      const now = new Date()
      for (const row of rows) {
        await db.update(table).set({ syncedAt: now }).where(sql`id = ${row.id}`)
      }
      console.log(`[Sync] Synced ${rows.length} rows from ${name}`)
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
