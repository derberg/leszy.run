// Operator corrections of a relay-in-any-order lap (routes/teamLaps.js). Pure checks, so the
// rules are tested without a database. A lap is one team_laps row; its number and time are
// derived on read, so every correction touches exactly one row.

/**
 * What a correction may write, or why it is refused.
 * @param {object} p
 * @param {{ id: string, startedAt: Date|string|null, category: { teamMode: string|null } }} p.run
 * @param {{ id: string, teamId: string|null, categoryId: string|null, removedAt?: Date|null }|null} p.participant
 *        the runner the lap is credited to (new or changed); null when the edit keeps the runner
 * @param {{ teamId: string, participantId: string }|null} p.lap the lap being changed (null: a new lap)
 * @param {{ closedAt?: string, participantId?: string, deleted?: boolean }} p.body
 * @param {Date} [p.now]
 * @returns {{ error: string, status: number } | { values: object }}
 */
export function lapEdit({ run, participant, lap, body, now = new Date() }) {
  if (run.category?.teamMode !== 'relay_free') return refuse(409, 'Ten bieg nie liczy okrążeń drużyn.')
  if (!run.startedAt) return refuse(409, 'Bieg jeszcze nie wystartował.')

  const values = {}
  if (body.participantId !== undefined || !lap) {
    if (!participant) return refuse(400, 'Wybierz zawodnika.')
    if (!participant.teamId) return refuse(422, 'Ten zawodnik nie jest w żadnej drużynie.')
    if (participant.categoryId !== run.category.id) return refuse(422, 'Ten zawodnik nie biegnie w tej kategorii.')
    if (participant.removedAt) return refuse(422, 'Ten zawodnik został wycofany z zapisów.')
    // A lap belongs to its team: moving it to another team would add a lap there and take one
    // away here, which is two corrections and two decisions.
    if (lap && participant.teamId !== lap.teamId) return refuse(422, 'Okrążenie można przypisać tylko komuś z tej samej drużyny.')
    values.participantId = participant.id
    values.teamId = participant.teamId
  }

  if (body.closedAt !== undefined || !lap) {
    const at = new Date(body.closedAt ?? now)
    if (Number.isNaN(at.getTime())) return refuse(400, 'Niepoprawny czas.')
    if (at <= new Date(run.startedAt)) return refuse(422, 'Okrążenie nie może się zamknąć przed startem.')
    if (at > new Date(now.getTime() + 60_000)) return refuse(422, 'Okrążenie nie może się zamknąć w przyszłości.')
    values.closedAt = at
  }

  if (body.deleted !== undefined) values.deletedAt = body.deleted ? now : null
  if (!lap) values.source = 'manual'
  return { values }
}

const refuse = (status, error) => ({ error, status })
