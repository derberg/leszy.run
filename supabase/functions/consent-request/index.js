// POST { token, sendCode?, code? } — the consent page's read (Plan 4, ruling 11).
// The link alone reveals the first name and nothing else: a forwarded or leaked link must not
// hand out a third party's birth date, phone or emergency contact. The data comes back only to a
// session whose address is the registration's, or after the e-mail code sent to that address.
//
//   no matching session, no code → 200 { data: { needsCode: true, event: { name, date, slug },
//       competition: { categoryId, name, startTime }, firstName, emailHint } } (emailHint:
//       p***@g***.com, consentAccess.js)
//   sendCode: true → a login code to the REGISTRATION's address (_shared/requestCode.js: its
//       per-address and per-IP limits); the client never names an address. Same answer, plus
//       codeSent: true. A retired address → 403 email_retired.
//   code → verifyCodeAndOpenSession for the registration's address (a new account when there is
//       none), the session cookie set, then the full answer.
//   matching session → 200 { data: { event, competition, person: { firstName, lastName,
//       birthDate, gender, email, phone, city, club, iceName, icePhone, nationality },
//       formFields, consents: [{ id, kind, text }], regulaminUrl, regulaminPath, editable } }
//
// Refusals: 410 { code: invalid | used | expired } „Ten link został już użyty albo wygasł.”,
// 409 gone (the entry was cancelled), 429 (consent-ip:<ip> 30/h, consent-token:<hash> 30/h, on
// every call). The token is never logged and never returned.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest, isAllowed } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clientIp } from '../_shared/clientIp.js'
import { verifyCodeAndOpenSession } from '../_shared/verifyCode.js'
import { requestLoginCode } from '../_shared/requestCode.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from '../_shared/deletedEmails.js'
import { json } from '../_shared/registration/registrationRequest.js'
import {
  emailHint, ipKey, loadByToken, personContext, personOf, sessionMatches, throttled, TOKEN_LIMIT, tokenHash, TOO_MANY,
} from '../_shared/registration/consentAccess.js'

const IP_LIMIT = 30
const KIND_ORDER = { regulamin: 0, data_info: 1, image: 2 }

function siteFor(req) {
  const origin = req.headers.get('Origin') ?? ''
  if (isAllowed(origin)) return origin
  return (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://www.leszy.run').replace(/\/+$/, '')
}

function regulaminOf(settings, path) {
  if (settings.regulamin_kind === 'link') return { regulaminUrl: settings.regulamin_url ?? null, regulaminPath: null }
  if (settings.regulamin_kind === 'pdf' && path) {
    const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
    return { regulaminUrl: `${base}/storage/v1/object/public/registration-files/${path}`, regulaminPath: path }
  }
  return { regulaminUrl: null, regulaminPath: null }
}

async function fullAnswer(admin, registration, settings, competition, publicPart) {
  const [{ data: consents, error }, { data: upload, error: uErr }] = await Promise.all([
    admin.from('event_consents').select('id, kind, text, sort_order, created_at').eq('event_id', registration.event_id),
    settings.regulamin_upload_id
      ? admin.from('registration_uploads').select('path, kind, event_id').eq('id', settings.regulamin_upload_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (error) throw error
  if (uErr) throw uErr
  const path = upload && upload.kind === 'regulamin' && upload.event_id === registration.event_id ? upload.path : null
  const ordered = (consents ?? []).slice().sort((a, b) =>
    (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || a.sort_order - b.sort_order ||
    String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
  return {
    event: publicPart.event,
    competition: publicPart.competition,
    person: personOf(registration),
    formFields: settings.form_fields ?? {},
    consents: ordered.map((c) => ({ id: c.id, kind: c.kind, text: c.text })),
    ...regulaminOf(settings, path),
    editable: Boolean(settings.closes_at) && Date.now() < Date.parse(settings.closes_at),
  }
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  let registrationId = null
  try {
    const hash = await tokenHash(body?.token)
    const ipThrottle = ipKey(req)
    const limited = await throttled(admin, req, [
      ...(ipThrottle ? [{ key: ipThrottle, limit: IP_LIMIT }] : []),
      { key: `consent-token:${hash}`, limit: TOKEN_LIMIT },
    ])
    if (limited) return limited

    const found = await loadByToken(admin, req, body?.token, hash)
    if (found.response) return found.response
    const { registration } = found
    registrationId = registration.id
    const { settings, competition } = await personContext(admin, registration)

    const publicPart = {
      event: { name: settings.name, date: settings.event_date, slug: settings.slug },
      competition: {
        categoryId: competition.category_id, name: competition.name,
        startTime: (competition.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null,
      },
    }
    const needsCode = (extra = {}) => json({
      data: { needsCode: true, ...publicPart, firstName: registration.first_name, emailHint: emailHint(registration.email), ...extra },
    }, 200, req)

    const session = await getSession(req, admin)
    if (sessionMatches(session, registration)) {
      return json({ data: await fullAnswer(admin, registration, settings, competition, publicPart) }, 200, req)
    }

    const { code, sendCode } = body ?? {}
    if (code != null && code !== '') {
      if (await isEmailRetired(admin, registration.email)) {
        return json({ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' }, 403, req)
      }
      const verified = await verifyCodeAndOpenSession(admin, { email: registration.email, code: String(code) })
      if (!verified.ok) {
        const extra = verified.retryAfterSec ? { 'retry-after': String(verified.retryAfterSec) } : {}
        return json({ error: verified.error, ...(verified.code ? { code: verified.code } : {}) }, verified.status, req, extra)
      }
      return json({ data: await fullAnswer(admin, registration, settings, competition, publicPart) }, 200, req,
        { 'Set-Cookie': verified.cookie })
    }

    if (sendCode === true) {
      const sent = await requestLoginCode(admin, { email: registration.email, ip: clientIp(req), linkBase: siteFor(req) })
      if (!sent.ok) {
        if (sent.status === 429) {
          return json({ error: TOO_MANY, code: 'throttled' }, 429, req, { 'retry-after': String(sent.retryAfterSec ?? 60) })
        }
        return json({ error: sent.error, ...(sent.code ? { code: sent.code } : {}) }, sent.status, req)
      }
      return needsCode({ codeSent: true })
    }

    return needsCode()
  } catch (err) {
    console.error('consent-request error:', registrationId ? `registration ${registrationId}:` : '', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
