// Live results updates without a refetch per change.
//
// The results page used to reload everything (8 requests) on every realtime
// change to `results`, in every open tab, once per category section. At
// Wilczy Półmaraton 2026-10-17 that was ~55k requests per 5 minutes from ~170
// viewers, and Supabase answered a one-row query in 15–35 s.

/**
 * Applies one realtime `results` change to the enriched results list.
 * Returns the new list, or null when the change cannot be applied locally
 * (a runner the page has not loaded, or a payload without a row), in which
 * case the caller reloads.
 */
export function applyResultChange(results, payload, pMap) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id
    return id ? results.filter(r => r.id !== id) : null
  }
  const row = payload.new
  if (!row?.id) return null
  const participant = pMap[row.participant_id]
  if (!participant) return null
  const enriched = {
    ...row,
    participantId: row.participant_id,
    startTime: row.start_time,
    finishTime: row.finish_time,
    durationMs: row.duration_ms,
    gunDurationMs: row.gun_duration_ms,
    participant,
  }
  const i = results.findIndex(r => r.id === row.id)
  if (i === -1) return [...results, enriched]
  const next = results.slice()
  next[i] = enriched
  return next
}

/**
 * Whether applyResultChange can apply this change without a reload. Decided
 * from the payload alone, because a React state updater may run later.
 */
export function canApplyResultChange(payload, pMap) {
  if (payload.eventType === 'DELETE') return Boolean(payload.old?.id)
  return Boolean(payload.new?.id && pMap[payload.new.participant_id])
}

/**
 * Runs fn once for a burst of triggers: the first trigger schedules a run
 * waitMs plus up to jitterMs later, and triggers before that run join it.
 * The jitter spreads the tabs that saw the same change over time.
 */
export function coalesce(fn, waitMs, jitterMs) {
  let timer = null
  return {
    trigger() {
      if (timer) return
      timer = setTimeout(() => { timer = null; fn() }, waitMs + Math.random() * jitterMs)
    },
    cancel() {
      clearTimeout(timer)
      timer = null
    },
  }
}
