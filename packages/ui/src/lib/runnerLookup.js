import { checkpointSplitMs } from './checkpointSplit.js'

const UNRANKED = new Set(['dns', 'dnf', 'dsq'])

// Lower case without Polish diacritics, so "lukasz" finds "Łukasz".
function fold(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Finds the runners a results-page search means.
 *
 * A bib search matches the whole number only: "20" must not show bib 200 as
 * the answer to "where is number 20". A name search matches any part of
 * "first last", ignoring case and diacritics, from two characters up.
 * Participants whose account was deleted are never matched by name.
 *
 * @param {Array} participants - [{ id, bibNumber, firstName, lastName, deleted_at }]
 * @param {string} query
 * @param {'bib'|'name'} mode
 * @returns {Array} the matching participants, in the order given
 */
export function findRunners(participants, query, mode) {
  const q = fold(query)
  if (!q) return []
  if (mode === 'bib') {
    // bib_number is an integer, so "07" means bib 7.
    const bib = q.replace(/^#/, '').replace(/^0+(?=\d)/, '')
    return participants.filter(p => p.bibNumber != null && String(p.bibNumber) === bib)
  }
  if (q.length < 2) return []
  return participants.filter(p =>
    !p.deleted_at && fold(`${p.firstName ?? ''} ${p.lastName ?? ''}`).includes(q))
}

/**
 * What the lookup card shows for one runner.
 *
 * @param {Array} ranked - results enriched by estimatePositions (all genders)
 * @param {string} participantId
 * @param {Array} checkpoints - [{ id, name }] in course order
 * @param {Array} observations - [{ checkpointId, participantId, bibNumber, observedAt }]
 * @param {string|null} gunStartedAt
 * @returns {null|{ positionType, position, gunDurationMs, durationMs, lastCheckpoint }}
 *   null when the runner has no result in this run. position is set only for a
 *   finisher. lastCheckpoint is the furthest checkpoint passed, with its split
 *   from the gun, for a runner still on course.
 */
export function runnerSummary(ranked, participantId, checkpoints, observations, gunStartedAt) {
  const r = ranked.find(x => x.participantId === participantId)
  if (!r) return null
  // A status an operator set outranks a chip finish: estimatePositions calls
  // anyone with a finish time 'final', and a disqualified runner keeps theirs.
  const positionType = UNRANKED.has(r.status) ? r.status : r.positionType
  let lastCheckpoint = null
  if (positionType === 'checkpoint') {
    const bib = r.participant?.bibNumber
    for (let i = checkpoints.length - 1; i >= 0 && !lastCheckpoint; i--) {
      const cp = checkpoints[i]
      const obs = observations.find(o => o.checkpointId === cp.id &&
        (o.participantId === participantId || (bib != null && o.bibNumber === bib)))
      if (obs) lastCheckpoint = { name: cp.name, splitMs: checkpointSplitMs(obs.observedAt, gunStartedAt) }
    }
  }
  return {
    positionType,
    position: positionType === 'final' ? r.estimatedPosition : null,
    gunDurationMs: r.gunDurationMs ?? null,
    durationMs: r.durationMs ?? null,
    lastCheckpoint,
  }
}
