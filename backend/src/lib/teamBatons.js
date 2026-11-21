// A relay team's baton is one RFID tag the team hands over; stored in team_batons. Pure refusal
// rules, so they are tested without a database.

/** The stored form of a typed tag: trimmed, upper case. null when not a non-empty string. */
export function normalizeBatonEpc(raw) {
  if (typeof raw !== 'string') return null
  return raw.trim().toUpperCase() || null
}

/**
 * Why assigning (or clearing) a team's baton is refused, or null.
 * @param {{ teamId: string, epc: unknown, members: object[], participantEpcs: string[],
 *           otherBatons: Array<{teamId: string, epc: string|null}> }} p
 *   members: the event's live participants of the team; participantEpcs: every participant tag in
 *   the event; otherBatons: the event's batons (the team's own row is ignored)
 * @returns {{ status: number, error: string } | null}
 */
export function batonRefusal({ teamId, epc, members, participantEpcs, otherBatons }) {
  if (!members?.length) return { status: 404, error: 'Nie ma takiej drużyny.' }
  if (epc === null) return null
  const tag = normalizeBatonEpc(epc)
  if (!tag) return { status: 400, error: 'Tag musi być niepustym tekstem albo null.' }
  if ((participantEpcs || []).some(e => typeof e === 'string' && e.trim().toUpperCase() === tag)) {
    return { status: 422, error: 'Ten tag jest przypisany zawodnikowi.' }
  }
  if ((otherBatons || []).some(b => b.teamId !== teamId && b.epc && b.epc.toUpperCase() === tag)) {
    return { status: 422, error: 'Ten tag jest już przypisany pałce innej drużyny.' }
  }
  return null
}

/**
 * Why a runner can not get this tag, or null: a baton tag of the event is never a runner's
 * (a read of it would both close a lap and count as the runner).
 * @param {unknown} epc the runner's new tag (null/empty: clearing)
 * @param {Array<string|null>} batonEpcs the event's baton tags
 * @returns {{ status: number, error: string } | null}
 */
export function runnerTagRefusal(epc, batonEpcs) {
  const tag = normalizeBatonEpc(epc)
  if (!tag) return null
  if ((batonEpcs || []).some(b => typeof b === 'string' && b.toUpperCase() === tag)) {
    return { status: 422, error: 'Ten tag ma pałka drużyny.' }
  }
  return null
}
