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
 * What changed in the current agreement version, in Polish, for the „Zaktualizowaliśmy umowę
 * organizatora” e-mail (registration-jobs step agreement_notices) and the club panel's banner.
 * Update it with every ORGANIZER_AGREEMENT_VERSION bump: an agreement change is an update the clubs
 * are told about, never a re-acceptance (§13 ust. 6, owner decision 2026-11-25).
 */
export const AGREEMENT_CHANGES = Object.freeze([
  'Organizator może zmienić konkurencję zgłoszenia, a jeżeli na to pozwala, także sam Uczestnik (§6 ust. 7–9).',
  'Przy zmianie na tańszą konkurencję różnica wraca automatycznie do płacącego; zgłoszenie nie jest anulowane.',
  'Przy zmianie na droższą konkurencję Uczestnik dopłaca różnicę online; dopłata należy się Organizatorowi.',
  'Uczestnik może sam poprawić dane swojego zgłoszenia (bez imienia, nazwiska i adresu e-mail), jeżeli Organizator na to pozwala (§4 ust. 6).',
  'Zmiany umowy są aktualizacjami: nowa wersja obowiązuje od dnia wysłania informacji e-mailem, a kto się z nią nie zgadza, zgłasza to w ciągu 7 dni na lukasz@leszy.run (§13 ust. 6).',
])

/**
 * The clubs among `clubIds` that accepted the organizer agreement, ANY version → Set of club ids.
 * A later version is an update with a notice e-mail, never a re-acceptance (§13 ust. 6), so the
 * runner's own competition change needs only that the club has the agreement at all
 * (selfServiceActions, and change_competition checks the same in SQL). A club with none: refused.
 */
export async function clubsWithAgreement(admin, clubIds) {
  const ids = [...new Set((clubIds ?? []).filter(Boolean))]
  if (!ids.length) return new Set()
  const { data, error } = await admin.from('organizer_agreements').select('club_id').in('club_id', ids)
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
