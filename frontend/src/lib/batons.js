// Relay baton helpers shared by the Zespoły tab and RaceControl.

/**
 * Team ids whose baton tag is also a runner's tag in the event (case-insensitive). The host
 * refuses that pairing, but tags reach a host through sync too.
 * @param {Array<{teamId: string, epc: string|null}>} batons
 * @param {Array<{rfidEpc?: string|null}>} participants
 * @returns {Set<string>}
 */
export function batonTagClashes(batons, participants) {
  const runnerTags = new Set(participants.filter(p => p.rfidEpc).map(p => p.rfidEpc.trim().toUpperCase()))
  return new Set(batons.filter(b => b.epc && runnerTags.has(b.epc.trim().toUpperCase())).map(b => b.teamId))
}
