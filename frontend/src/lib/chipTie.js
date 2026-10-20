// Finishes the chip cannot put in order. Each finish is the peak read of that
// tag's own pass, taken independently, and a tag is read every 50 to 250 ms.
// At Wilczy Półmaraton 2026-10-17 bibs 203 and 201 finished 28 ms apart in that
// order. The photo and the volunteer both had 201 first, and 201's peak was
// only 0.5 dB above a read 92 ms earlier.
export const CHIP_TIE_MS = 500

// The same set as UNRANKED in backend/src/lib/positions.js: none of them places.
const UNRANKED = new Set(['dns', 'dnf', 'dsq'])

/**
 * Groups of finishers in one race run whose finishes are less than CHIP_TIE_MS
 * apart, each finish from the one before it. A group where any finish was set
 * by hand (`manualOverride`) is left out: a person has already ordered it.
 * @param {Array<{ id: string, raceRunId: string, finishTime: string | null, status: string, manualOverride?: boolean }>} results
 * @returns {Map<string, Array<object>>} result id → its group, sorted by finish
 */
export function chipTies(results) {
  const byRun = new Map()
  for (const r of results) {
    if (!r.finishTime || UNRANKED.has(r.status)) continue
    if (!byRun.has(r.raceRunId)) byRun.set(r.raceRunId, [])
    byRun.get(r.raceRunId).push(r)
  }

  const ties = new Map()
  for (const rows of byRun.values()) {
    rows.sort((a, b) => Date.parse(a.finishTime) - Date.parse(b.finishTime))
    let group = [rows[0]]
    const close = () => {
      if (group.length > 1 && !group.some(r => r.manualOverride)) {
        for (const r of group) ties.set(r.id, group)
      }
    }
    for (const r of rows.slice(1)) {
      const gap = Date.parse(r.finishTime) - Date.parse(group.at(-1).finishTime)
      if (gap < CHIP_TIE_MS) group.push(r)
      else { close(); group = [r] }
    }
    close()
  }
  return ties
}

/** Number of distinct groups in a `chipTies()` result. */
export function chipTieCount(ties) {
  return new Set(ties.values()).size
}

/** Spread of a group from its first finish to its last, in ms. */
export function chipTieSpreadMs(group) {
  return Date.parse(group.at(-1).finishTime) - Date.parse(group[0].finishTime)
}

/**
 * The finish that puts `result` first in its group and leaves everyone else's
 * time alone: 1 ms before the group's earliest finish. A runner who is first
 * already keeps her own finish. Saving it still sets `manualOverride`, which is
 * how a group the chip ordered correctly stops being flagged.
 * @returns {string} ISO timestamp
 */
export function finishToLeadGroup(group, result) {
  if (group[0].id === result.id) return new Date(result.finishTime).toISOString()
  return new Date(Date.parse(group[0].finishTime) - 1).toISOString()
}

/** Wall-clock ms of a camera frame: its sensor stamp (ns) plus the session's clock offset (s). */
export function frameWallMs(ts, clockOffset) {
  return (Number(ts) / 1e9 + clockOffset) * 1000
}

/** Index of the frame closest in time to `atMs`, or -1 when there are none. */
export function nearestFrameIndex(frames, clockOffset, atMs) {
  let best = -1
  for (let i = 0; i < frames.length; i++) {
    const d = Math.abs(frameWallMs(frames[i], clockOffset) - atMs)
    if (best < 0 || d < Math.abs(frameWallMs(frames[best], clockOffset) - atMs)) best = i
  }
  return best
}

/** The camera session that was recording at `atMs`. */
export function sessionAt(sessions, atMs) {
  return sessions.find(s => s.clockOffset != null
    && Date.parse(s.startedAt) <= atMs
    && (!s.stoppedAt || atMs <= Date.parse(s.stoppedAt))) ?? null
}
