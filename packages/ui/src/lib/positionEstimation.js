/**
 * Estimates race positions for a list of results, enriched with checkpoint observations.
 *
 * @param {Array} results - result rows, each with { id, participantId, startTime, finishTime,
 *                          gunDurationMs, status, participant: { bibNumber, firstName, lastName, club } }
 * @param {Array} checkpoints - checkpoint rows sorted by km_marker asc: [{ id, name, kmMarker }]
 * @param {Array} observations - observation rows: [{ checkpointId, participantId, observedAt }]
 * @returns {Array} results sorted by estimated position, each with { ...result, estimatedPosition, positionType }
 *   positionType: 'final' | 'checkpoint' | 'started' | 'not-started' | 'dnf' | 'dns' | 'dsq'
 *
 * Observations of a DNS runner are discarded (see dnsParticipantIds below). DNF and
 * DSQ keep theirs — those runners were genuinely on course.
 */
export function estimatePositions(results, checkpoints, observations) {
  // Build observation map: participantId -> { checkpointIdx, observedAt }
  const cpIndexById = Object.fromEntries(checkpoints.map((cp, i) => [cp.id, i]))

  // Build bib -> participantId map from results (to resolve obs where participant_id is null)
  const bibToParticipantId = {}
  for (const r of results) {
    if (r.participant?.bibNumber != null && r.participantId) {
      bibToParticipantId[r.participant.bibNumber] = r.participantId
    }
  }

  // DNS asserts the runner never left the start line, so ANY observation for them
  // is bogus — a mistyped bib on the volunteer numpad, or a stray read. Dropping it
  // here (rather than only downgrading the badge further down) is what keeps them
  // out of the checkpoint sorting tier: Nocny Zew Wilka 2026-08-07, bib 1 was DNS,
  // got one manual 5 km entry, and outranked every runner actually on course.
  // DNF/DSQ are deliberately NOT included — they ran, so their splits are real.
  const dnsParticipantIds = new Set(
    results.filter(r => r.status === 'dns' && r.participantId).map(r => r.participantId)
  )

  const obsMap = {}

  for (const obs of observations) {
    const pid = obs.participantId || bibToParticipantId[obs.bibNumber]
    if (!pid) continue
    if (dnsParticipantIds.has(pid)) continue
    const idx = cpIndexById[obs.checkpointId]
    if (idx === undefined) continue
    const existing = obsMap[pid]
    if (!existing || idx > existing.checkpointIdx ||
        (idx === existing.checkpointIdx && new Date(obs.observedAt) < new Date(existing.observedAt))) {
      obsMap[pid] = { checkpointIdx: idx, observedAt: obs.observedAt }
    }
  }

  const enriched = results.map(r => {
    const obs = obsMap[r.participantId]
    return { ...r, _obs: obs }
  })

  // Sort: finished first (by gunDurationMs), then by furthest checkpoint, then by start time
  enriched.sort((a, b) => {
    const aFinished = !!a.finishTime
    const bFinished = !!b.finishTime

    if (aFinished && bFinished) return (a.gunDurationMs || 0) - (b.gunDurationMs || 0)
    if (aFinished) return -1
    if (bFinished) return 1

    const aObs = a._obs, bObs = b._obs
    if (aObs && bObs) {
      if (aObs.checkpointIdx !== bObs.checkpointIdx) return bObs.checkpointIdx - aObs.checkpointIdx
      return new Date(aObs.observedAt) - new Date(bObs.observedAt)
    }
    if (aObs) return -1
    if (bObs) return 1

    const aStarted = !!a.startTime
    const bStarted = !!b.startTime
    if (aStarted && bStarted) return new Date(a.startTime) - new Date(b.startTime)
    if (aStarted) return -1
    if (bStarted) return 1
    return 0
  })

  return enriched.map((r, i) => ({
    ...r,
    estimatedPosition: i + 1,
    positionType: r.finishTime ? 'final'
      : (r.status === 'dnf' || r.status === 'dns' || r.status === 'dsq') ? r.status
      : r._obs ? 'checkpoint'
      : r.startTime ? 'started'
      : 'not-started',
  }))
}
