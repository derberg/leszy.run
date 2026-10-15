// A volunteer's finish entry next to the chip finish. The chip still decides the
// result: this only tells the operator which rows to check by hand.
//
// On 2026-08-07 five runners got a chip finish 1.4 to 15.5 min after the
// volunteer's entry, from a read when they walked back past the gate. A volunteer
// normally types the bib 1 to 26 s after the chip, so 60 s is clear of that.
export const FINISH_MISMATCH_MS = 60_000

/**
 * The volunteer's time for a runner, from the observations at checkpoints marked
 * as the manual finish ("Ręczna meta").
 * @param {Array<{ id: string, isFinish?: boolean }>} checkpoints
 * @param {(checkpointId: string) => string | undefined} observedAt
 * @returns {string | null} ISO timestamp
 */
export function volunteerFinishAt(checkpoints, observedAt) {
  for (const cp of checkpoints) {
    if (!cp.isFinish) continue
    const t = observedAt(cp.id)
    if (t) return t
  }
  return null
}

/**
 * @param {string | null} finishTime the result's finish, ISO
 * @param {string | null} volunteerAt the volunteer's entry, ISO
 * @returns {{ kind: 'mismatch' | 'no-finish', volunteerAt: string, diffMs: number | null } | null}
 *   `mismatch`: both exist and differ by more than FINISH_MISMATCH_MS;
 *   `no-finish`: the volunteer saw the runner finish and the result has no finish.
 */
export function volunteerFinishCheck(finishTime, volunteerAt) {
  if (!volunteerAt) return null
  if (!finishTime) return { kind: 'no-finish', volunteerAt, diffMs: null }
  const diffMs = new Date(finishTime) - new Date(volunteerAt)
  if (Math.abs(diffMs) <= FINISH_MISMATCH_MS) return null
  return { kind: 'mismatch', volunteerAt, diffMs }
}
