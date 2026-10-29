// Consent requests (Plan 4): an adult registered by somebody else gets one e-mail with a
// single-use link to accept the regulamin (ruling 10: it is also the Art. 14 notice). Only a
// CONFIRMED registration awaiting consent gets one, so a paid group's adults are asked when the
// payment lands (settleConfirmOutcome), never while the order waits, and never for an expired
// or refunded one. issue_consent_request claims the row (insert … on conflict do nothing), so a
// replay (an IPN dpay sends again, a second caller) sends nothing.
//
// Reminders (remind-consent, and registration-jobs' automatic one 72 h before closes_at) and the
// job's re-send of a first e-mail that never went out all go through rotateAndSend: a new token,
// rotate_consent_request (the old link dies), then the e-mail. consent_requests.emailed_at is
// stamped after every e-mail the sender accepted, so the job knows which links nobody has.
//
// The token exists only in this process and in the e-mail: the database keeps its SHA-256
// (tokens.js), and nothing here logs it or the address. Runs on the admin (service role) client.
import { sendEmail } from '../email.js'
import { newToken } from './tokens.js'
import { consentRequestEmail } from './emails.js'

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

const envSite = () => (globalThis.Deno?.env.get('PUBLIC_SITE_URL') ?? '').replace(/\/+$/, '')

/** The consent page: the token travels in the fragment, never in the path or the query. */
export const consentLink = (site, token) => `${site}/zgoda#${token}`

/** The runner data information of the event, which the consent e-mail links (Art. 14). */
export const dataInfoUrl = (site, slug) => `${site}/events/${encodeURIComponent(slug)}/informacja-o-danych`

const REG_COLUMNS = 'id, event_id, category_id, first_name, email, status, consent_state, registered_by_profile_id'

/**
 * Who provided the added adult's data, for the e-mail: the registering person's own entry in the
 * event, else the guardian name their children carry, else the account's display name or address.
 */
async function registeredByNames(admin, regs) {
  const byProfile = new Map()
  const ids = [...new Set(regs.map((r) => r.registered_by_profile_id).filter(Boolean))]
  if (!ids.length) return byProfile
  const events = [...new Set(regs.map((r) => r.event_id))]
  const [own, kids, profiles] = await Promise.all([
    rows(admin.from('registrations').select('profile_id, first_name, last_name')
      .in('event_id', events).in('profile_id', ids)),
    rows(admin.from('registrations').select('guardian_profile_id, guardian_name')
      .in('event_id', events).in('guardian_profile_id', ids).not('guardian_name', 'is', null)),
    rows(admin.from('profiles').select('id, display_name, email').in('id', ids)),
  ])
  for (const p of profiles) byProfile.set(p.id, p.display_name || p.email || null)
  for (const k of kids) byProfile.set(k.guardian_profile_id, k.guardian_name)
  for (const o of own) {
    const name = `${o.first_name ?? ''} ${o.last_name ?? ''}`.trim()
    if (name) byProfile.set(o.profile_id, name)
  }
  return byProfile
}

/** Everything the e-mails of `regs` need besides the token: → (registration) → mail builder. */
async function mailContext(admin, regs, { registeredBy = null, site = null } = {}) {
  const events = [...new Set(regs.map((r) => r.event_id))]
  const cats = [...new Set(regs.map((r) => r.category_id))]
  const [settingsRows, comps, names] = await Promise.all([
    rows(admin.from('registration_settings')
      .select('event_id, name, slug, event_date, first_start_time, town_label, place_details').in('event_id', events)),
    rows(admin.from('competitions').select('category_id, name, start_time').in('category_id', cats)),
    registeredBy ? Promise.resolve(new Map()) : registeredByNames(admin, regs),
  ])
  const settingsBy = new Map(settingsRows.map((s) => [s.event_id, s]))
  const compBy = new Map(comps.map((c) => [c.category_id, c]))
  const base = (site ?? envSite()).replace(/\/+$/, '')
  return (r, token, { reminder = false } = {}) => {
    const settings = settingsBy.get(r.event_id)
    if (!settings) return null
    const comp = compBy.get(r.category_id) ?? {}
    return consentRequestEmail({
      event: {
        name: settings.name,
        eventDate: settings.event_date,
        place: [settings.town_label, settings.place_details].filter(Boolean).join(', ') || null,
      },
      person: { firstName: r.first_name },
      registeredBy: registeredBy ?? names.get(r.registered_by_profile_id) ?? null,
      competition: { name: comp.name ?? null, startTime: (comp.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null },
      link: consentLink(base, token),
      dataInfoUrl: dataInfoUrl(base, settings.slug),
      reminder,
    })
  }
}

// Sends; throws when the sender refused. Then stamps emailed_at on the request that still holds
// this token (a rotation meanwhile means another e-mail carries the live link).
async function deliver(admin, r, hash, mail) {
  const res = await sendEmail({ to: r.email, ...mail })
  if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
  const { error } = await admin.from('consent_requests').update({ emailed_at: new Date().toISOString() })
    .eq('registration_id', r.id).eq('token_hash', hash)
  if (error) console.error(`consent request ${r.id}: emailed_at not stamped:`, error.message)
}

/**
 * For each registration of `registrationIds` that is confirmed, awaiting consent and has an
 * address: a fresh token, issue_consent_request, and the e-mail only when that call returned
 * true (this caller claimed the request). → the number of e-mails handed to the sender.
 * `registeredBy` (optional) names who registered, when the caller knows it; `site` overrides
 * PUBLIC_SITE_URL (the jobs pass theirs). Never throws: the registrations stand whatever
 * happens here; a failure is logged without address or token.
 */
export async function issueConsentRequests(admin, registrationIds, { registeredBy = null, site = null } = {}) {
  const ids = [...new Set((registrationIds ?? []).filter(Boolean))]
  if (!ids.length) return 0
  let sent = 0
  try {
    const regs = await rows(admin.from('registrations').select(REG_COLUMNS)
      .in('id', ids).eq('status', 'confirmed').eq('consent_state', 'awaiting').not('email', 'is', null))
    if (!regs.length) return 0
    const build = await mailContext(admin, regs, { registeredBy, site })

    for (const r of regs) {
      try {
        const { token, hash } = await newToken()
        const { data: issued, error } = await admin.rpc('issue_consent_request', { p_registration_id: r.id, p_token_hash: hash })
        if (error) throw error
        if (issued !== true) continue // already issued (a replay), or no longer confirmed + awaiting
        const mail = build(r, token)
        if (!mail) continue
        await deliver(admin, r, hash, mail)
        sent++
      } catch (err) {
        // At most once here: emailed_at stays NULL, and registration-jobs re-sends the link
        // once (claim_consent_resends) after 10 minutes.
        console.error(`consent request ${r.id} not sent:`, err?.message)
      }
    }
  } catch (err) {
    console.error('consent requests failed:', err?.message)
  }
  return sent
}

/** issueConsentRequests for every registration of an order (a paid group, on confirmation). */
export async function issueOrderConsentRequests(admin, orderId, opts = {}) {
  try {
    const regs = await rows(admin.from('registrations').select('id').eq('order_id', orderId))
    return await issueConsentRequests(admin, regs.map((r) => r.id), opts)
  } catch (err) {
    console.error('consent requests for order failed:', err?.message)
    return 0
  }
}

/**
 * A new link for one registration: a fresh token, rotate_consent_request (the old link dies),
 * then the e-mail — „Przypomnienie: …” unless `reminder` is false (the job's re-send of a first
 * e-mail that never went out). A registration that is confirmed and awaiting but has no request
 * at all (the crash window) is issued one instead, sent as a first e-mail.
 * → 'sent' | 'not_awaiting' (accepted, office, cancelled, spent or expired) | 'failed' (the
 * e-mail was not accepted; the token is rotated all the same). Throws on a database error.
 */
export async function rotateAndSend(admin, registrationId, { reminder = true, site = null } = {}) {
  const { data: r, error } = await admin.from('registrations').select(REG_COLUMNS).eq('id', registrationId).maybeSingle()
  if (error) throw error
  if (!r || r.status !== 'confirmed' || r.consent_state !== 'awaiting' || !r.email) return 'not_awaiting'

  const { token, hash } = await newToken()
  const { data: rotated, error: rErr } = await admin.rpc('rotate_consent_request', { p_registration_id: r.id, p_token_hash: hash })
  if (rErr) throw rErr
  let first = !reminder
  if (rotated !== true) {
    const { data: existing, error: eErr } = await admin.from('consent_requests').select('id').eq('registration_id', r.id).maybeSingle()
    if (eErr) throw eErr
    if (existing) return 'not_awaiting'
    const { data: issued, error: iErr } = await admin.rpc('issue_consent_request', { p_registration_id: r.id, p_token_hash: hash })
    if (iErr) throw iErr
    if (issued !== true) return 'not_awaiting'
    first = true
  }

  try {
    const build = await mailContext(admin, [r], { site })
    const mail = build(r, token, { reminder: !first })
    if (!mail) throw new Error('no event settings')
    await deliver(admin, r, hash, mail)
    return 'sent'
  } catch (err) {
    console.error(`consent link ${r.id} not sent:`, err?.message)
    return 'failed'
  }
}
