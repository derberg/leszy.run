// Who belongs on the "Blisko Mety" list: runners seen at the near-finish checkpoint
// who have not crossed the finish yet. The list used to keep everyone who ever passed
// the checkpoint, so by the end of a race it held most of the field.
//
// A DNS runner never left the start line, so an observation under their bib is
// bogus — a mistyped bib on the volunteer numpad, or a stray read. Nocny Zew
// Wilka 2026-08-07: bib 1 was DNS and one manual entry put him into the
// on-course views. DNF/DSQ are deliberately kept — they were on course.

/**
 * Split result rows into the participants to leave off the list.
 * Callers pass only rows of active/finished runs: a cancelled restart can leave a
 * stale row behind for someone running in the current attempt.
 * @param {Array<{ participant_id: string, status: string, finish_time: string|null }>} results
 */
export function excludedParticipants(results) {
  const dns = new Set()
  const finished = new Set()
  for (const r of results || []) {
    if (r.status === 'dns') dns.add(r.participant_id)
    else if (r.finish_time || r.status === 'finished') finished.add(r.participant_id)
  }
  return { dns, finished }
}

/**
 * One row per runner (earliest observation), newest first.
 * @param {object} p
 * @param {Array} p.observations - checkpoint_observations rows
 * @param {Array} p.participants - participants_public rows
 * @param {{ dns: Set<string>, finished: Set<string> }} p.excluded
 * @param {Record<string, string>} p.catMap - category id → name
 */
export function nearFinishRunners({ observations, participants, excluded, catMap }) {
  const pById = Object.fromEntries(participants.map(p => [p.id, p]))
  const pByBib = Object.fromEntries(participants.map(p => [p.bib_number, p]))

  const seen = new Set()
  const out = []
  const sorted = [...observations].sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at))
  for (const obs of sorted) {
    const p = (obs.participant_id && pById[obs.participant_id]) || pByBib[obs.bib_number]
    if (p && (excluded.dns.has(p.id) || excluded.finished.has(p.id))) continue
    const key = p ? p.id : `bib-${obs.bib_number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: obs.id,
      bibNumber: obs.bib_number,
      observedAt: obs.observed_at,
      first_name: p?.first_name || '?',
      last_name: p?.last_name || '?',
      deleted_at: p?.deleted_at || null,
      categoryName: p ? (catMap[p.category_id] || '') : '',
    })
  }
  return out.sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt))
}
