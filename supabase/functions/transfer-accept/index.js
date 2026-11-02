// POST — the recipient's side of a package transfer (Plan 7, RA7). The link works for whoever holds
// it (§12.6): a forwarded link is accepted by whoever proves their own address, and the sender is
// told who that was.
//
//   { token } → 200 { data: { event: { name, date, slug, place }, senderFirstName, competition:
//       { categoryId, name, startTime }, priceLabel, competitions: [{ categoryId, name, startTime,
//       minAge, maxAge }] (the same-price options, ruling 2), consents: [{ id, kind, text }],
//       formFields, regulaminUrl, until, expiresAt, registrationClosed } }
//       Nothing else about the sender: no surname, address, phone or birth date.
//   { token, sendCode: true, email } → a login code to the address the recipient typed (the code
//       only, no link: the token lives in this tab), → 200 { data: { codeSent: true } }.
//       403 email_retired (RETIRED_EMAIL_MESSAGE), 429 (requestCode's own limits).
//   { token, code?, person, categoryId, acceptedConsentIds, serviceRegulamin } → the acceptance:
//       the address is person.email, proved by the code (verifyCodeAndOpenSession, which sets the
//       session cookie) or by a session already on it; validatePerson for the target competition
//       (400 invalid_person with `fields`); every event consent, the image acceptance included,
//       and the service regulamin (400 consents_required otherwise, nothing accepted; D7-8);
//       accept_transfer; then „Pakiet przejęła …” to the sender and „Jesteś na liście” to the
//       recipient, each claimed on the transfer row (at most once) and only after the RPC returned
//       (a certain send failure gives the claim back and registration-jobs re-sends it once; an
//       unknown outcome keeps the claim and alerts the operator).
//       → 200 { data: { status: 'accepted', registrationId, event: { name, slug } } }.
//       401 code_required (no code and no matching session), the code's own 400/401/403/429.
//       The client sends the person on with postAuthPath({ skipOnboarding: true }).
//
// Every call claims transfer-ip:<ip> (300/h; a missing address counts in the shared `unknown` bucket) and transfer-token:<hash> (10/h). A dead link (unknown,
// used, cancelled, expired, or its entry no longer confirmed) is 409 gone; transfers switched off
// or past their date 409 transfer_off; a refund of the entry waiting for dpay 409 refund_pending
// (V-87), on every call, so no code is sent while it waits. The token is looked up by its SHA-256 only, and never
// logged or returned.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest, isAllowed } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clientIp } from '../_shared/clientIp.js'
import { verifyCodeAndOpenSession } from '../_shared/verifyCode.js'
import { requestLoginCode } from '../_shared/requestCode.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from '../_shared/deletedEmails.js'
import { json, personContexts } from '../_shared/registration/registrationRequest.js'
import { throttled, tokenHash, TOO_MANY } from '../_shared/registration/consentAccess.js'
import { validatePerson } from '../_shared/registration/person.js'
import { formatPln } from '../_shared/registration/money.js'
import { warsawToday } from '../_shared/registration/dates.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { callTransferRpc, GONE, sendAcceptedTransferEmail, TRANSFER_REFUSALS } from '../_shared/registration/transfers.js'
import { refundsInFlight } from '../_shared/registration/refundInFlight.js'
import { requiredConsents } from '../_shared/registration/consents.js'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Per client address (clientIp, #333): generous, because a whole carrier's CGNAT or an office can share
// one address; the per-token cap (10/h) and the e-mail code are the per-link guards.
const HOUR_IP_LIMIT = 300
const TOKEN_LIMIT = 10
const CONSENTS = 'Zaznacz wymagane zgody.'
const INVALID = 'Popraw zaznaczone pola.'
const KIND_ORDER = { regulamin: 0, data_info: 1, image: 2 }

const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))
const idList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
const startOf = (comp, settings) => (comp?.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null

function siteFor(req) {
  const origin = req.headers.get('Origin') ?? ''
  if (isAllowed(origin)) return origin
  return (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://www.leszy.run').replace(/\/+$/, '')
}

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

const refuse = (req, code, headers = {}) => {
  const [status, error] = TRANSFER_REFUSALS[code]
  return json({ error, code }, status, req, headers)
}

/**
 * The live invite of a token, with its entry and the event → { transfer, reg, settings } or
 * { response } (409 gone, 409 transfer_off). The checks the RPC makes again under its locks.
 */
async function loadInvite(admin, req, token, hash) {
  const gone = { response: json({ error: GONE, code: 'gone' }, 409, req) }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return gone
  const transfer = await single(admin.from('transfers')
    .select('id, registration_id, event_id, status, expires_at').eq('token_hash', hash).eq('kind', 'runner').maybeSingle())
  if (!transfer || transfer.status !== 'pending' || Date.parse(transfer.expires_at) <= Date.now()) return gone
  const reg = await single(admin.from('registrations')
    .select('id, event_id, category_id, order_id, team_id, first_name, status, list_price').eq('id', transfer.registration_id).maybeSingle())
  if (!reg || reg.status !== 'confirmed') return gone
  const settings = await single(admin.from('registration_settings').select('*').eq('event_id', reg.event_id).single())
  if (!settings.transfer_enabled || !settings.transfer_until || warsawToday() > settings.transfer_until) {
    return { response: refuse(req, 'transfer_off') }
  }
  // V-87 (M-1): refused on the preview, before a code is sent, while a refund of the entry waits.
  if ((await refundsInFlight(admin, [reg.id])).has(reg.id)) return { response: refuse(req, 'refund_pending') }
  return { transfer, reg, settings }
}

/**
 * The competitions the package can move to (ruling 2): the target's list price in the old order's
 * frozen tier equals the entry's list price; with no tier the price is 0 zł. A team's package stays
 * in its competition; a team competition never takes a single runner; hidden ones are left out.
 */
async function samePriceCompetitions(admin, reg) {
  const comps = await rows(admin.from('competitions')
    .select('category_id, name, start_time, kind, hidden_at, min_age, max_age').eq('event_id', reg.event_id).order('category_id'))
  const order = reg.order_id ? await single(admin.from('orders').select('tier_id').eq('id', reg.order_id).maybeSingle()) : null
  const prices = order?.tier_id
    ? new Map((await rows(admin.from('competition_prices').select('category_id, amount').eq('tier_id', order.tier_id)))
      .map((p) => [p.category_id, p.amount]))
    : null
  const priceOf = (c) => (prices ? prices.get(c.category_id) ?? null : 0)
  return comps.filter((c) => {
    if (reg.team_id) return c.category_id === reg.category_id
    if (c.kind === 'team') return false
    if (c.category_id !== reg.category_id && c.hidden_at) return false
    return priceOf(c) === reg.list_price
  })
}

async function consentsOf(admin, eventId) {
  // The recipient is an adult: a minors-only consent is not theirs (consents.js).
  const list = requiredConsents(await rows(admin.from('event_consents')
    .select('id, kind, text, sort_order, created_at, minors_only').eq('event_id', eventId)))
  return list.sort((a, b) => (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || a.sort_order - b.sort_order ||
    String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
}

async function regulaminUrlOf(admin, settings) {
  if (settings.regulamin_kind === 'link') return settings.regulamin_url ?? null
  if (settings.regulamin_kind !== 'pdf' || !settings.regulamin_upload_id) return null
  const upload = await single(admin.from('registration_uploads').select('path, kind, event_id')
    .eq('id', settings.regulamin_upload_id).maybeSingle())
  if (!upload || upload.kind !== 'regulamin' || upload.event_id !== settings.event_id) return null
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
  return `${base}/storage/v1/object/public/registration-files/${upload.path}`
}

const eventFacts = (settings) => ({
  name: settings.name,
  eventDate: settings.event_date,
  place: [settings.town_label, settings.place_details].filter(Boolean).join(', ') || null,
})

async function preview(admin, req, { transfer, reg, settings }) {
  const [options, consents, regulaminUrl] = await Promise.all([
    samePriceCompetitions(admin, reg),
    consentsOf(admin, reg.event_id),
    regulaminUrlOf(admin, settings),
  ])
  const own = await single(admin.from('competitions').select('category_id, name, start_time').eq('category_id', reg.category_id).single())
  return json({
    data: {
      event: { name: settings.name, date: settings.event_date, slug: settings.slug, place: eventFacts(settings).place },
      senderFirstName: reg.first_name,
      competition: { categoryId: own.category_id, name: own.name, startTime: startOf(own, settings) },
      priceLabel: formatPln(reg.list_price ?? 0),
      competitions: options.map((c) => ({
        categoryId: c.category_id, name: c.name, startTime: startOf(c, settings), minAge: c.min_age, maxAge: c.max_age,
      })),
      consents: consents.map((c) => ({ id: c.id, kind: c.kind, text: c.text })),
      formFields: settings.form_fields ?? {},
      regulaminUrl,
      until: settings.transfer_until,
      expiresAt: transfer.expires_at,
      registrationClosed: Boolean(settings.closes_at) && Date.now() >= Date.parse(settings.closes_at),
    },
  }, 200, req)
}

async function sendCode(admin, req, body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email) || email.length > 254) return refuse(req, 'invalid_email')
  const sent = await requestLoginCode(admin, { email, ip: await clientIp(req), linkBase: siteFor(req), link: false })
  if (!sent.ok) {
    if (sent.status === 429) {
      return json({ error: TOO_MANY, code: 'throttled' }, 429, req, { 'retry-after': String(sent.retryAfterSec ?? 60) })
    }
    return json({ error: sent.error, ...(sent.code ? { code: sent.code } : {}) }, sent.status, req)
  }
  return json({ data: { codeSent: true } }, 200, req)
}

async function accept(admin, req, body, hash, { transfer, reg, settings }) {
  const person = body.person && typeof body.person === 'object' && !Array.isArray(body.person) ? body.person : null
  const email = typeof person?.email === 'string' ? person.email.trim().toLowerCase() : ''
  if (!person || !EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: INVALID, code: 'invalid_person', fields: { email: 'Podaj poprawny adres e-mail.' } }, 400, req)
  }

  // ---- the address: a session already on it, or the code sent to it
  let profileId = null
  let withCookie = {}
  const session = await getSession(req, admin)
  if (session?.email && session.email.trim().toLowerCase() === email) {
    profileId = session.userId
  } else {
    const code = body.code
    if (code == null || code === '') return json({ error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }, 401, req)
    if (await isEmailRetired(admin, email)) return json({ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' }, 403, req)
    const verified = await verifyCodeAndOpenSession(admin, { email, code: String(code) })
    if (!verified.ok) {
      const extra = verified.retryAfterSec ? { 'retry-after': String(verified.retryAfterSec) } : {}
      return json({ error: verified.error, ...(verified.code ? { code: verified.code } : {}) }, verified.status, req, extra)
    }
    profileId = verified.profile.id
    withCookie = { 'Set-Cookie': verified.cookie }
  }

  // ---- the person, for the competition they take
  const categoryId = body.categoryId
  const competition = isUuid(categoryId)
    ? await single(admin.from('competitions').select('*').eq('category_id', categoryId).eq('event_id', reg.event_id).maybeSingle())
    : null
  if (!competition) {
    return json({ error: INVALID, code: 'invalid_person', fields: { categoryId: 'Wybierz konkurencję.' } }, 400, req, withCookie)
  }
  const ctx = (await personContexts(admin, settings, [competition])).get(competition.category_id)
  const checked = validatePerson({ ...person, email }, { ...ctx, now: new Date() })
  if (!checked.ok) return json({ error: INVALID, code: 'invalid_person', fields: checked.errors }, 400, req, withCookie)

  // ---- every event consent (image included) but a minors-only one, and the service regulamin,
  // or nothing is accepted
  const consentIds = (await consentsOf(admin, reg.event_id)).map((c) => c.id)
  const { acceptedConsentIds, serviceRegulamin } = body
  if (serviceRegulamin !== true || !idList(acceptedConsentIds) || !sameSet(acceptedConsentIds, consentIds)) {
    return json({ error: CONSENTS, code: 'consents_required' }, 400, req, withCookie)
  }

  const { isMinor: _minor, ...value } = checked.value
  const { data: out, error } = await callTransferRpc(admin, 'accept_transfer', {
    p_token_hash: hash,
    p_person: { ...value, email },
    p_category_id: competition.category_id,
    p_profile_id: profileId,
    p_consent: { consentIds: acceptedConsentIds, serviceRegulamin: true },
    p_meta: { ip: await clientIp(req), userAgent: req.headers.get('user-agent') || null },
  })
  if (error) {
    if (!TRANSFER_REFUSALS[error.message]) throw error
    const [status, text] = TRANSFER_REFUSALS[error.message]
    return json({ error: text, code: error.message, ...(error.message === 'invalid_person' ? { fields: {} } : {}) }, status, req, withCookie)
  }

  // ---- only now, after a successful return: the two e-mails, each claimed once. Built from the
  // stored rows (the job's re-send builds the same); a failure here never turns the accepted
  // transfer into a 500 (M-1): a certain failure gives its claim back for registration-jobs.
  const accepted = { id: transfer.id, kind: 'runner', status: 'accepted', event_id: reg.event_id,
    registration_id: reg.id, new_registration_id: out.registrationId }
  await sendAcceptedTransferEmail(admin, accepted, 'accepted_emailed_at')
  await sendAcceptedTransferEmail(admin, accepted, 'confirmation_emailed_at')

  return json({
    data: { status: 'accepted', registrationId: out.registrationId, event: { name: settings.name, slug: settings.slug } },
  }, 200, req, withCookie)
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  let ref = null
  try {
    const hash = await tokenHash(body?.token)
    const ip = (await clientIp(req)) ?? 'unknown'
    const limited = await throttled(admin, req, [
      { key: `transfer-ip:${ip}`, limit: HOUR_IP_LIMIT },
      { key: `transfer-token:${hash}`, limit: TOKEN_LIMIT },
    ])
    if (limited) return limited

    const found = await loadInvite(admin, req, body?.token, hash)
    if (found.response) return found.response
    ref = `transfer ${found.transfer.id}`

    if (body.sendCode === true) return await sendCode(admin, req, body)
    if (body.person != null || body.code != null) return await accept(admin, req, body, hash, found)
    return await preview(admin, req, found)
  } catch (err) {
    console.error('transfer-accept error:', ref ?? '', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
