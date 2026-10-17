// A participant who came but will not start ("Nie startuje" in the participants
// table). The flag lives on the participant because it is usually set before the
// gun, when no result row exists yet; race start then seeds the result as DNS.

/**
 * Why a withdrawal is refused, or null when it may go ahead. A runner with a
 * finish time was on course, so that is a DNF or DSQ decision, not a withdrawal.
 * @param {{ finishTime: Date|string|null, gunDurationMs: number|null, durationMs: number|null }[]} runResults
 * @returns {string|null}
 */
export function withdrawalRefusal(runResults) {
  const finished = runResults.find(r => r.finishTime)
  if (!finished) return null
  const ms = finished.gunDurationMs ?? finished.durationMs
  const time = ms != null ? ` (${formatDuration(ms)})` : ''
  return `Ma już czas mety${time}. Zmień status w Przeglądzie trasy (DNF / DSQ).`
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
