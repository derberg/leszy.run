import { eq, sql } from 'drizzle-orm'
import { checkpoints, participants, checkpointObservations } from '../db/schema.js'

// Applies one checkpoint_observations change that arrived over Supabase
// realtime. Two rules keep a stray row from taking the backend down:
//
// - An observation whose checkpoint this host never pulled is skipped. The
//   release smoke test writes bib 902 to a throwaway [e2e-test] checkpoint,
//   which configSync refuses, and a draft or external event's checkpoints are
//   refused the same way. Inserting such a row broke the checkpoint FK, the
//   rejection had no handler, and Node exited (2026-11-04, after #420's release).
// - Any other error is logged and swallowed: a realtime callback is fire and
//   forget, so a throw here is an unhandled rejection, which ends the process.
//
// `io` is the host's side of it (see realtimeIo below); tests pass a fake.
export async function applyRemoteObservation(remote, kind, io) {
  if (!remote?.id) return
  try {
    const eventId = await io.checkpointEventId(remote.checkpoint_id)
    if (!eventId) {
      io.log(`[Sync] Realtime checkpoint_observation ${kind}: bib ${remote.bib_number} skipped (checkpoint ${remote.checkpoint_id} is not on this host)`)
      return
    }
    io.log(`[Sync] Realtime checkpoint_observation ${kind}: bib ${remote.bib_number} (${remote.source})`)

    const participantId = await io.participantIdFor(eventId, remote.bib_number)
    const row = {
      id: remote.id,
      checkpointId: remote.checkpoint_id,
      bibNumber: remote.bib_number,
      participantId,
      observedAt: new Date(remote.observed_at),
      source: remote.source ?? 'manual',
      syncedAt: new Date(),
    }

    // The priority trigger upgrades a 'manual' row to 'rfid' in place (same
    // id), which arrives as an UPDATE. A host that missed the INSERT inserts it.
    if (kind === 'UPDATE') {
      if (!(await io.update(row))) await io.insert(row)
    } else {
      await io.insert(row)
    }

    io.broadcast({
      id: remote.id,
      checkpointId: remote.checkpoint_id,
      bibNumber: remote.bib_number,
      participantId,
      observedAt: remote.observed_at,
      source: remote.source ?? 'manual',
    })
  } catch (err) {
    io.log(`[Sync] Realtime checkpoint_observation ${kind} for bib ${remote.bib_number} failed: ${err.message}`)
  }
}

export function realtimeIo(db, broadcast) {
  return {
    checkpointEventId: async (id) => {
      const [cp] = await db.select({ eventId: checkpoints.eventId }).from(checkpoints).where(eq(checkpoints.id, id))
      return cp?.eventId ?? null
    },
    participantIdFor: async (eventId, bib) => {
      const [found] = await db.select({ id: participants.id })
        .from(participants)
        .where(sql`event_id = ${eventId} AND bib_number = ${bib}`)
      return found?.id ?? null
    },
    insert: (row) => db.insert(checkpointObservations).values(row).onConflictDoNothing(),
    update: async (row) => {
      const [updated] = await db.update(checkpointObservations)
        .set({ observedAt: row.observedAt, source: row.source, participantId: row.participantId, syncedAt: row.syncedAt })
        .where(eq(checkpointObservations.id, row.id))
        .returning({ id: checkpointObservations.id })
      return !!updated
    },
    broadcast: (payload) => broadcast('checkpoint:observation', payload),
    log: (msg) => console.log(msg),
  }
}
