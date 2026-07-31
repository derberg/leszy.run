// Periodically upserts this checkpoint's live status to Supabase
// (checkpoint_agents, anon key, display-only) so the admin checkpoints tab
// can show configured/armed_waiting/listening + basic counters per Pi. Never
// lets an upsert failure (network blip, RLS surprise) escape the interval —
// a heartbeat write failure must not crash the agent or interrupt recording.
export function createHeartbeat({ supabase, checkpointId, intervalMs = 15000, getStatus }) {
  let timer = null

  async function tick() {
    try {
      const { status, readsTotal, queuePending, unknownCount } = getStatus()
      const now = new Date().toISOString()
      await supabase.from('checkpoint_agents').upsert(
        {
          checkpoint_id: checkpointId,
          status,
          reads_total: readsTotal,
          queue_pending: queuePending,
          unknown_count: unknownCount,
          last_seen_at: now,
          updated_at: now,
        },
        { onConflict: 'checkpoint_id' },
      )
      // A returned {error} (vs. a thrown exception) is also swallowed here —
      // display-only status, worth retrying next tick, never worth surfacing
      // to the recording pipeline.
    } catch {
      /* swallow — retry next tick */
    }
  }

  function start() {
    if (timer) return
    tick() // immediate upsert so status shows up without waiting a full interval
    timer = setInterval(tick, intervalMs)
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { start, stop }
}
