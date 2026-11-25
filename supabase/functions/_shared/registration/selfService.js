// The runner's own changes from „Moje zapisy” (spec Part 2): who may act on an entry, and which
// actions the lists offer. my-entry-action decides every request (this module only says what the
// buttons show), and my-registrations / my-event-registrations use the same rule so a button is
// never offered for an entry the function would answer 404.
// Plain ESM: runs in Deno and Node.

/**
 * The session may act on this entry: its own (`profile_id`), an adult entry at the session's
 * address, or a child's entry whose guardian is the session's profile.
 * @param {{ profile_id?: string|null, email?: string|null, guardian_profile_id?: string|null }} reg
 * @param {{ userId: string, email?: string|null }} session
 */
export function actsOnEntry(reg, session) {
  if (!reg || !session) return false
  const sessionEmail = typeof session.email === 'string' ? session.email.trim().toLowerCase() : null
  return (reg.profile_id != null && reg.profile_id === session.userId)
    || (reg.email != null && sessionEmail != null && reg.email.trim().toLowerCase() === sessionEmail)
    || (reg.email == null && reg.guardian_profile_id != null && reg.guardian_profile_id === session.userId)
}

/**
 * Which of „Zmień konkurencję” and „Popraw dane” the lists show for one entry.
 * None for a club with registration switched off (my-entry-action answers it 404). Both: the club's switch on, before `closes_at`, an entry the session acts on. A team entry never
 * changes competition; only its captain edits (their own data). A change needs a confirmed entry
 * with no surcharge waiting (the list links the surcharge instead); an edit also takes an entry
 * awaiting payment, as runner_edit_registration does.
 * @param {object} p
 * @param {object} p.reg registrations row: status, profile_id, email, guardian_profile_id, team_id
 * @param {object} p.settings registration_settings row: runner_competition_change, runner_data_edit, closes_at
 * @param {{ userId: string, email?: string|null }} p.session
 * @param {boolean} p.clubEnabled clubs.registration_enabled of the event's club
 * @param {boolean} [p.clubAgreement] the club accepted the organizer agreement (any version)
 *   (clubsWithAgreement): a competition change needs it, a data edit (no money) does not
 * @param {Iterable<string>|null} [p.changeTargets] the event's visible (hidden_at NULL) individual
 *   competitions (changeTargetsByEvent): a change is offered only when one of them is not the
 *   entry's own, so an event with a single individual competition never offers it
 * @param {boolean} [p.captain] the entry is its team's captain (ignored without team_id)
 * @param {boolean} [p.surchargeOpen]
 * @param {Date} [p.now]
 * @returns {{ change: boolean, edit: boolean }}
 */
export function selfServiceActions({ reg, settings, session, clubEnabled, clubAgreement = false, changeTargets = null, captain = false, surchargeOpen = false, now = new Date() }) {
  const none = { change: false, edit: false }
  if (clubEnabled !== true || !reg || !settings || !actsOnEntry(reg, session)) return none
  const closes = settings.closes_at ? Date.parse(settings.closes_at) : NaN
  if (!Number.isFinite(closes) || now.getTime() >= closes) return none
  const team = reg.team_id != null
  if (team && !captain) return none
  return {
    change: settings.runner_competition_change === true && clubAgreement === true && !team && reg.status === 'confirmed' && !surchargeOpen
      && hasChangeTarget(changeTargets, reg.category_id),
    edit: settings.runner_data_edit === true && (reg.status === 'confirmed' || reg.status === 'pending_payment'),
  }
}

/** One of `targets` (visible individual competition ids of the event) is not `categoryId`. */
export function hasChangeTarget(targets, categoryId) {
  for (const id of targets ?? []) if (id !== categoryId) return true
  return false
}

const PAGE = 1000

/**
 * The visible (hidden_at NULL) individual competitions of each event → Map<eventId, Set<categoryId>>,
 * one query per 100 events (paged), for selfServiceActions' `changeTargets`.
 */
export async function changeTargetsByEvent(admin, eventIds) {
  const ids = [...new Set((eventIds ?? []).filter(Boolean))]
  const out = new Map(ids.map((id) => [id, new Set()]))
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from('competitions').select('event_id, category_id')
        .in('event_id', chunk).is('hidden_at', null).eq('kind', 'individual')
        .order('category_id').range(from, from + PAGE - 1)
      if (error) throw error
      for (const c of data ?? []) out.get(c.event_id)?.add(c.category_id)
      if (!data || data.length < PAGE) break
    }
  }
  return out
}
