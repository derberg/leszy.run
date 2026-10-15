/**
 * Time from the gun to a checkpoint observation, in ms.
 *
 * Measured from the gun rather than from the runner's own chip start so a split
 * sits on the same axis as the brutto result the table ranks by, and so it exists
 * for a runner who was never read at the start line.
 *
 * @param {string|null} observedAt - ISO timestamp of the observation
 * @param {string|null} gunStartedAt - ISO timestamp of the race run's gun
 * @returns {number|null} null when either time is missing or the observation
 *   precedes the gun (a mistyped volunteer entry, not a split)
 */
export function checkpointSplitMs(observedAt, gunStartedAt) {
  if (!observedAt || !gunStartedAt) return null
  const ms = new Date(observedAt).getTime() - new Date(gunStartedAt).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}
