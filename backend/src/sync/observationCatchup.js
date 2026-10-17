import { sql } from 'drizzle-orm'

// CATCH-UP PULL for checkpoint_observations (Supabase → local).
//
// Volunteer entries are written to Supabase by the phone app, and the only path
// that brought them into the local DB was the Realtime subscription. Realtime is
// not a delivery guarantee: at the Wilczy Półmaraton on 2026-10-17 the channel
// went CHANNEL_ERROR → CLOSED → TIMED_OUT at 11:00:25 and never came back, and
// 204 entries on "Meta" and "Tuż tuż" reached Supabase but never this host. The
// results page reads the local DB, so half the volunteer finishes were missing.
//
// So Realtime stays as the fast path, and this poll is the guarantee: every cycle
// it reads the observations of the checkpoints in play and inserts the ones the
// local DB lacks. The insert goes through the local priority trigger (0030), so a
// (checkpoint, bib) pair already held under another id is dropped, exactly as a
// Realtime INSERT would be.

const PAGE = 1000 // PostgREST caps a response at 1000 rows, whatever the limit says

/**
 * Every remote observation for the given checkpoints, paginated past the
 * 1000-row cap.
 */
export async function fetchRemoteObservations(supabase, checkpointIds) {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('checkpoint_observations')
      .select('id, checkpoint_id, bib_number, observed_at, source')
      .in('checkpoint_id', checkpointIds)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all.push(...data)
    if (data.length < PAGE) return all
  }
}

// Checkpoints of events with a race running now or started in the last day.
// Older events are settled; re-reading them every cycle would only cost bandwidth.
async function checkpointsInPlay(db) {
  const rows = await db.execute(sql`
    SELECT c.id FROM checkpoints c
     WHERE EXISTS (
       SELECT 1 FROM race_runs rr JOIN categories cat ON cat.id = rr.category_id
        WHERE cat.event_id = c.event_id
          AND (rr.status = 'active' OR rr.started_at > now() - interval '24 hours'))`)
  return rows.map(r => r.id)
}

/**
 * Inserts the remote observations the local DB lacks, and mirrors a remote
 * manual → rfid upgrade onto a local row that has no pending local edit.
 * Returns the rows that changed locally, for the live broadcast.
 */
export async function pullCheckpointObservations(db, supabase) {
  const ids = await checkpointsInPlay(db)
  if (!ids.length) return []
  const remote = await fetchRemoteObservations(supabase, ids)
  if (!remote.length) return []

  const payload = JSON.stringify(remote)
  const inserted = await db.execute(sql`
    INSERT INTO checkpoint_observations
      (id, checkpoint_id, bib_number, participant_id, observed_at, source, synced_at)
    SELECT v.id, v.checkpoint_id, v.bib_number,
           (SELECT p.id FROM participants p
             WHERE p.event_id = c.event_id AND p.bib_number = v.bib_number LIMIT 1),
           v.observed_at, coalesce(v.source, 'manual'), now()
      FROM jsonb_to_recordset(${payload}::jsonb)
           AS v(id uuid, checkpoint_id uuid, bib_number int, observed_at timestamptz, source text)
      JOIN checkpoints c ON c.id = v.checkpoint_id
     WHERE NOT EXISTS (SELECT 1 FROM checkpoint_observations o WHERE o.id = v.id)
    ON CONFLICT (id) DO NOTHING
    RETURNING id, checkpoint_id, bib_number, participant_id, observed_at, source`)

  // The Realtime UPDATE handler's job, for an UPDATE that was missed. A row with
  // synced_at NULL holds a local edit not yet pushed, and the push wins first.
  const updated = await db.execute(sql`
    UPDATE checkpoint_observations o
       SET observed_at = v.observed_at, source = v.source, synced_at = now()
      FROM jsonb_to_recordset(${payload}::jsonb)
           AS v(id uuid, observed_at timestamptz, source text)
     WHERE o.id = v.id
       AND o.synced_at IS NOT NULL
       AND (o.observed_at, o.source) IS DISTINCT FROM (v.observed_at, v.source)
    RETURNING o.id, o.checkpoint_id, o.bib_number, o.participant_id, o.observed_at, o.source`)

  return [...inserted, ...updated]
}
