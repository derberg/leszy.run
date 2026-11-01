// A5's leg order. The form section's `legOrder` is a map of every saved team
// competition: categoryId → on. Staging replaces the map whole, so one changed
// competition still sends all of them. A staged key always counts as a pending
// change, so on a published event the map goes only when it differs from the
// live values, or when a map is already staged and must be replaced: it cannot
// be taken back any other way. A draft writes straight to the tables, and the
// map goes with every save.

export const teamCompetitions = (competitions) => (competitions ?? []).filter((c) => c.kind === 'team')

export function legOrderChoices(teams) {
  return Object.fromEntries(teams.filter((c) => c.categoryId).map((c) => [c.categoryId, c.legOrderEnabled === true]))
}

/** → the map to send, or null to leave the key out. `teams` as stagedEvent() shows them. */
export function legOrderToSend({ state, teams, choices, staged }) {
  const saved = teams.filter((c) => c.categoryId)
  if (!saved.length) return null
  const map = Object.fromEntries(saved.map((c) => [c.categoryId, choices[c.categoryId] === true]))
  if (state === 'draft' || staged) return map
  return saved.some((c) => map[c.categoryId] !== (c.legOrderLive ?? c.legOrderEnabled === true)) ? map : null
}
