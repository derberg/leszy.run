// „Zaktualizowaliśmy umowę organizatora”: the registration-jobs step agreement_notices.
//
// A new organizer agreement version is an update, never a re-acceptance (agreement §13 ust. 6,
// owner decision 2026-11-25): it applies from the day the clubs are told, and a club that does not
// accept it writes to lukasz@leszy.run within 7 days. Shipping a version is: bump
// ORGANIZER_AGREEMENT_VERSION (and public/src/legal/organizerAgreement.js), rewrite
// AGREEMENT_CHANGES, merge. The next run claims every enabled club whose newest acceptance is an
// older version (claim_agreement_notices: one organizer_agreement_notices row per club and version,
// inserted before the e-mail, so a club is told at most once per version) and e-mails its owner and
// admins, one e-mail per address. A failed send is alerted (email_failed, template
// agreement_notice) and never resent: the claim stays, sent_at stays NULL.
import { sendEmail } from '../email.js'
import { AGREEMENT_CHANGES, ORGANIZER_AGREEMENT_VERSION } from '../organizer.js'
import { escapeHtml, link } from './emails.js'
import { raiseAlert } from './orderFlow.js'

export const AGREEMENT_NOTICE_SUBJECT = 'Zaktualizowaliśmy umowę organizatora'
export const OBJECTION_TEXT = 'Jeśli nie akceptujesz zmian, napisz do lukasz@leszy.run w ciągu 7 dni — wtedy umowa wygasa, a opublikowane wydarzenia obsłużymy do końca na dotychczasowych zasadach.'

/** The agreement page in the club panel. `site` is PUBLIC_SITE_URL (never a request header). */
export function agreementPageUrl(site, slug) {
  return `${String(site).replace(/\/+$/, '')}/klub/${encodeURIComponent(slug)}/wydarzenia/umowa`
}

/** → { subject, text, html }. Pure. */
export function agreementNoticeEmail({ clubName, version, changes, url }) {
  const lead = `Umowa organizatora LESZY.RUN, którą zaakceptował klub ${clubName}, ma nową wersję: ${version}. Obowiązuje od dziś i nie trzeba jej ponownie akceptować.`
  const text = [
    'Cześć,', '', lead, '', 'Co się zmieniło:', ...changes.map((c) => `- ${c}`), '',
    `Umowa: ${url}`, '', OBJECTION_TEXT, '', 'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>${escapeHtml(lead)}</p>`,
    '<p>Co się zmieniło:</p>',
    `<ul>${changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`,
    link(url, 'Przeczytaj umowę'),
    `<p>${escapeHtml(OBJECTION_TEXT)}</p>`,
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: AGREEMENT_NOTICE_SUBJECT, text, html }
}

/** The club's active owner and admins with a live profile → their addresses, deduplicated. */
export async function clubManagerAddresses(admin, clubId) {
  const { data: members, error } = await admin.from('club_members')
    .select('user_id').eq('club_id', clubId).eq('status', 'active').in('role', ['owner', 'admin'])
  if (error) throw error
  const ids = [...new Set((members ?? []).map((m) => m.user_id).filter(Boolean))]
  if (!ids.length) return []
  const { data: profiles, error: pErr } = await admin.from('profiles')
    .select('email').in('id', ids).is('deleted_at', null)
  if (pErr) throw pErr
  const seen = new Map()
  for (const p of profiles ?? []) {
    const email = typeof p.email === 'string' ? p.email.trim() : ''
    if (email && !seen.has(email.toLowerCase())) seen.set(email.toLowerCase(), email)
  }
  return [...seen.values()]
}

/** One claimed club: e-mail every address, stamp sent_at only when all went out. → e-mails sent */
async function noticeClub(admin, clubId, { site, version, changes }) {
  let sent = 0
  try {
    const { data: club, error } = await admin.from('clubs').select('name, slug').eq('id', clubId).maybeSingle()
    if (error) throw error
    if (!club) return 0
    const message = agreementNoticeEmail({ clubName: club.name, version, changes, url: agreementPageUrl(site, club.slug) })
    const addresses = await clubManagerAddresses(admin, clubId)
    const failed = []
    for (const to of addresses) {
      try {
        const res = await sendEmail({ to, ...message, noTracking: true })
        if (res && res.ok === false) failed.push(`not accepted (${res.status})`)
        else sent++
      } catch (err) {
        failed.push(String(err?.message ?? err))
      }
    }
    if (failed.length) {
      await raiseAlert(admin, 'email_failed', null, { template: 'agreement_notice', clubId, version, failed: failed.length, sent })
      return sent
    }
    await admin.from('organizer_agreement_notices').update({ sent_at: new Date().toISOString() })
      .eq('club_id', clubId).eq('version', version)
  } catch (err) {
    console.error('registration-jobs: agreement notice failed:', err?.message)
    await raiseAlert(admin, 'email_failed', null, { template: 'agreement_notice', clubId, version, error: String(err?.message ?? err) })
  }
  return sent
}

/** The step. → { clubs, emails } */
export async function sendAgreementNotices(admin, { site, limit = 50, version = ORGANIZER_AGREEMENT_VERSION, changes = AGREEMENT_CHANGES } = {}) {
  const { data, error } = await admin.rpc('claim_agreement_notices', { p_version: version, p_limit: limit })
  if (error) throw new Error(`claim_agreement_notices: ${error.message}`)
  const clubs = (data ?? []).map((r) => (typeof r === 'string' ? r : r?.claim_agreement_notices ?? r?.club_id)).filter(Boolean)
  let emails = 0
  for (const clubId of clubs) emails += await noticeClub(admin, clubId, { site, version, changes })
  return { clubs: clubs.length, emails }
}
