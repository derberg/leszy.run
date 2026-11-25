// Shared by the organizer-side registration functions.
import { clientIp } from './clientIp.js'

// Bump together with public/src/legal/organizerAgreement.js (public/tests/unit/agreementVersion.test.js checks it).
export const ORGANIZER_AGREEMENT_VERSION = '2026-11-v7'

/** The caller's active role in the club ('owner' | 'admin' | 'member'), or null. */
export async function clubRole(admin, clubId, userId) {
  const { data } = await admin.from('club_members')
    .select('role').eq('club_id', clubId).eq('user_id', userId).eq('status', 'active').maybeSingle()
  return data?.role ?? null
}

/**
 * The clubs among `clubIds` that accepted the CURRENT agreement version → Set of club ids. The
 * runner's own competition change moves the club's money through dpay with no organizer action,
 * which only that version covers (§6 ust. 7–9): without it the change is neither offered
 * (selfServiceActions) nor allowed (change_competition, given the version as p_agreement_version).
 */
export async function clubsOnCurrentAgreement(admin, clubIds) {
  const ids = [...new Set((clubIds ?? []).filter(Boolean))]
  if (!ids.length) return new Set()
  const { data, error } = await admin.from('organizer_agreements').select('club_id')
    .in('club_id', ids).eq('version', ORGANIZER_AGREEMENT_VERSION)
  if (error) throw error
  return new Set((data ?? []).map((a) => a.club_id))
}

export async function clubRegistrationEnabled(admin, clubId) {
  const { data } = await admin.from('clubs').select('registration_enabled').eq('id', clubId).maybeSingle()
  return data?.registration_enabled === true
}

// The one validated parser (clientIp.js); re-exported for the functions that import it from here.
export { clientIp }

/**
 * Appends one organizer_actions row. Never throws: a failed insert is logged and answered false,
 * so a caller that must not act unaudited (the CSV export) can refuse.
 * @returns {Promise<boolean>} whether the row was stored
 */
export async function logOrganizerAction(admin, req, { actorId, clubId, eventId = null, action, target = null, payload = null }) {
  try {
    const { error } = await admin.from('organizer_actions').insert({
      actor_id: actorId, club_id: clubId, event_id: eventId, action, target, payload,
      ip: await clientIp(req), user_agent: req.headers.get('user-agent') || null,
    })
    if (!error) return true
    console.error('organizer_actions insert failed:', error.message)
  } catch (err) {
    console.error('organizer_actions insert failed:', err?.message)
  }
  return false
}
