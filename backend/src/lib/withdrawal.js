// A participant who came but will not start ("Nie startuje" in the participants
// table). The flag lives on the participant because it is usually set before the
// gun, when no result row exists yet; race start then seeds the result as DNS.

/**
 * Why a withdrawal is refused, or null when it may go ahead. A runner with a
 * finish time, a DNF or a DSQ was on course, and a withdrawal would overwrite
 * that decision with DNS for good.
 * @param {{ status: string, finishTime: Date|string|null, gunDurationMs: number|null, durationMs: number|null }[]} runResults
 * @returns {string|null}
 */
export function withdrawalRefusal(runResults) {
  const finished = runResults.find(r => r.finishTime)
  if (finished) {
    const ms = finished.gunDurationMs ?? finished.durationMs
    const time = ms != null ? ` (${formatDuration(ms)})` : ''
    return `Ma już czas mety${time}. Zmień status w Przeglądzie trasy (DNF / DSQ).`
  }
  const decided = runResults.find(r => r.status === 'dnf' || r.status === 'dsq')
  if (decided) return `Ma już status ${decided.status.toUpperCase()}. Zmień go w Przeglądzie trasy.`
  return null
}

/**
 * The gun time a returning runner gets when the withdrawal is undone after the
 * gun-time backfill already ran, or null. The backfill skipped them while they
 * were DNS, and without a start their finish pass would be read as a start.
 * @param {{ status: string, startedAt: Date|string|null }} run
 * @param {{ gunBackfillEnabled?: boolean, gunBackfillSeconds?: number }} event
 * @param {{ startTime: Date|string|null }} result
 * @param {boolean} checkedIn
 * @param {Date} now
 * @returns {Date|null}
 */
export function gunStartOnReturn(run, event, result, checkedIn, now) {
  if (run.status !== 'active' || !run.startedAt || result.startTime || !checkedIn) return null
  if (event.gunBackfillEnabled === false) return null
  const gun = new Date(run.startedAt)
  const backfillMs = (event.gunBackfillSeconds ?? 60) * 1000
  return now - gun >= backfillMs ? gun : null
}

/**
 * The status a DNS result goes back to when the withdrawal is undone: the one
 * the race would have given the runner without it.
 * @param {{ startTime: Date|string|null }} result
 * @param {boolean} checkedIn
 */
export function statusAfterReturn(result, checkedIn) {
  if (result.startTime) return 'started'
  return checkedIn ? 'checked_in' : 'registered'
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}
