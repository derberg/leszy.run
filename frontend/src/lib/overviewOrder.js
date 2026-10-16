// Row order of the "Przegląd trasy" table, which lists every category together.
//
// Finishers come first, in the order they crossed the line, so the latest one is
// at the bottom. They used to be sorted by `position`, but a position counts
// within one category: the three winners came first, then the three second
// places, and the Meta column jumped back and forth in time.
//
// Runners still on course follow, furthest checkpoint first, then by bib.
// `obsLookup` maps `${participantId}:${checkpointId}` to an observation time.
export function sortOverviewRows(rows, sortedCps, obsLookup) {
  const lastCp = (r) => sortedCps.findLastIndex(cp => obsLookup[`${r.participantId}:${cp.id}`])
  return [...rows].sort((a, b) => {
    if (a.finishTime && b.finishTime) {
      return Date.parse(a.finishTime) - Date.parse(b.finishTime) || (a.position || 999) - (b.position || 999)
    }
    if (a.finishTime && !b.finishTime) return -1
    if (!a.finishTime && b.finishTime) return 1
    return lastCp(b) - lastCp(a) || (a.participant?.bibNumber || 0) - (b.participant?.bibNumber || 0)
  })
}
