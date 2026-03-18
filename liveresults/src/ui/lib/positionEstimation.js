/**
 * Estimates race positions for a list of results, enriched with checkpoint observations.
 *
 * @param {Array} results - result rows, each with { id, participantId, startTime, finishTime,
 *                          gunDurationMs, status, participant: { bibNumber, firstName, lastName, club } }
 * @param {Array} checkpoints - checkpoint rows sorted by km_marker asc: [{ id, name, kmMarker }]
 * @param {Array} observations - observation rows: [{ checkpointId, participantId, observedAt }]
 * @returns {Array} results sorted by estimated position, each with { ...result, estimatedPosition, positionType }
 *   positionType: 'final' | 'checkpoint' | 'started' | 'not-started'
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

  const obsMap = {}

  for (const obs of observations) {
    const pid = obs.participantId || bibToParticipantId[obs.bibNumber]
    if (!pid) continue
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
      : r._obs ? 'checkpoint'
      : r.startTime ? 'started'
      : 'not-started',
  }))
}
