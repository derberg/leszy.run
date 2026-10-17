// Row order of the "Przegląd trasy" table, which lists every category together.
//
// Finishers come first, in the order they crossed the line, so the latest one is
// at the bottom. They used to be sorted by `position`, but a position counts
// within one category: the three winners came first, then the three second
// places, and the Meta column jumped back and forth in time.
//
// Runners still on course follow, furthest checkpoint first, then by bib. After
// them come the runners not yet started, then DNF, DSQ and DNS, each by bib.
// `obsLookup` maps `${participantId}:${checkpointId}` to an observation time.

const CLOSED_RANK = { dnf: 3, dsq: 4, dns: 5 }

/** Which group of the overview a result falls into: 0 finished … 5 DNS. */
export function overviewGroup(r) {
  if (CLOSED_RANK[r.status]) return CLOSED_RANK[r.status]
  if (r.finishTime) return 0
  if (r.startTime) return 1
  return 2
}

export function sortOverviewRows(rows, sortedCps, obsLookup) {
  const lastCp = (r) => sortedCps.findLastIndex(cp => obsLookup[`${r.participantId}:${cp.id}`])
  const bib = (r) => r.participant?.bibNumber || 0
  return [...rows].sort((a, b) => {
    const ga = overviewGroup(a)
    const gb = overviewGroup(b)
    if (ga !== gb) return ga - gb
    if (ga === 0) {
      return Date.parse(a.finishTime) - Date.parse(b.finishTime) || (a.position || 999) - (b.position || 999)
    }
    if (ga === 1) return lastCp(b) - lastCp(a) || bib(a) - bib(b)
    return bib(a) - bib(b)
  })
}
