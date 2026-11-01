// Who an organizer message reaches. Plain ESM: runs in Deno and Node.
import { registrationRole } from './group.js'

const STATUSES = {
  confirmed: ['confirmed'],
  awaiting: ['pending_payment'],
  all: ['confirmed', 'pending_payment'],
}
const TEAM_SCOPES = new Set(['members', 'captains'])

const normalize = (email) => (email ?? '').trim().toLowerCase()

/**
 * One recipient per address. A minor is written to through the guardian alone, so a minor whose
 * guardian address is gone (account deleted, 30-day purge) reaches nobody.
 * @param {object[]} rows  `registrations` rows (id, status, category_id, email, the guardian
 *   columns, team_id), each with `is_captain` from teams.captain_registration_id
 * @param {object} filter
 * @param {string[]} [filter.categoryIds] empty or absent means every competition
 * @param {'confirmed'|'awaiting'|'all'} filter.status
 * @param {'members'|'captains'} filter.teams  'captains' drops the other members of a team and
 *   leaves individual entries in: narrow to team competitions with categoryIds
 * @returns {{ email: string, registrationIds: string[] }[]} in order of first appearance
 */
export function resolveAudience(rows, { categoryIds = [], status, teams }) {
  // A filter nobody recognises must not fall through to everybody.
  const statuses = STATUSES[status]
  if (!statuses) throw new Error('invalid_status')
  if (!TEAM_SCOPES.has(teams)) throw new Error('invalid_teams')

  const recipients = new Map()
  for (const row of rows) {
    if (!statuses.includes(row.status)) continue
    if (categoryIds.length > 0 && !categoryIds.includes(row.category_id)) continue
    if (teams === 'captains' && row.team_id && !row.is_captain) continue
    const email = normalize(registrationRole(row) === 'minor' ? row.guardian_email : row.email)
    if (!email) continue
    if (!recipients.has(email)) recipients.set(email, { email, registrationIds: [] })
    recipients.get(email).registrationIds.push(row.id)
  }
  return [...recipients.values()]
}
