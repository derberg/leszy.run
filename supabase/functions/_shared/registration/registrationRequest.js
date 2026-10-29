// What register-free and create-order do before their RPC, in one place and one order:
// the event from the competition (404 for a draft, an unknown competition or a disabled
// club), the early window answers, the person (validatePerson), the consents (every event
// consent, image included, plus the LESZY.RUN service regulamin), a retired address, the
// throttles, and who registers (the session when its address is the person's, otherwise
// the e-mail code, which logs the person in and sets the cookie). Deno only (session,
// throttle and code verification touch the database through the admin client).
import { getCorsHeaders } from '../cors.js'
import { getSession } from '../session.js'
import { checkAndIncrement } from '../throttle.js'
import { verifyCodeAndOpenSession } from '../verifyCode.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from '../deletedEmails.js'
import { clubRegistrationEnabled } from '../organizer.js'
import { isUuid } from './organizerEvent.js'
import { isOpen } from './dates.js'
import { validatePerson } from './person.js'
import { MAX_PEOPLE_PER_REQUEST } from './flags.js'

export function json(body, status, req, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...headers },
  })
}

export const NOT_FOUND = { error: 'Not found' }

// The RPCs' refusals (exception messages) and what the runner reads.
export const REFUSALS = {
  full: [409, 'Brak wolnych miejsc w tej konkurencji.'],
  closed: [409, 'Zapisy są zamknięte.'],
  not_open: [409, 'Zapisy jeszcze się nie rozpoczęły.'],
  not_free: [409, 'Zapisy na te zawody są płatne. Płatności online będą dostępne wkrótce.'],
  duplicate: [409, 'Ten adres e-mail jest już zapisany na te zawody.'],
  consents_changed: [400, 'Zaznacz wymagane zgody.'],
}

export const refusal = (code, req, headers = {}, table = REFUSALS) => {
  const [status, error] = table[code]
  return json({ error, code }, status, req, headers)
}

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

/**
 * Runs the shared steps. → { response } for an early answer, or
 * { competition, settings, people, consentIds, email, profileId, withCookie }.
 * `pricing(settings)` returns a refusal code (a key of `refusals`) for an event this path does
 * not serve, or null.
 * `throttles(email)` lists the counters to claim: [{ key, limit, windowSeconds }].
 */
export async function prepareRegistration(req, admin, body, { pricing, throttles, refusals = REFUSALS }) {
  const { categoryId, acceptedConsentIds, serviceRegulamin, code } = body ?? {}
  const people = Array.isArray(body?.people) ? body.people : body?.person ? [body.person] : []
  if (people.length === 0) return { response: json({ error: 'Brak danych osoby.' }, 400, req) }
  if (people.length > MAX_PEOPLE_PER_REQUEST) {
    return { response: json({ error: 'Można zapisać jedną osobę naraz.', code: 'too_many_people' }, 400, req) }
  }

  // ---- the event, derived from the competition
  if (!isUuid(categoryId)) return { response: json(NOT_FOUND, 404, req) }
  const { data: competition, error: compErr } = await admin.from('competitions')
    .select('*').eq('category_id', categoryId).maybeSingle()
  if (compErr) throw compErr
  if (!competition) return { response: json(NOT_FOUND, 404, req) }
  const { data: settings, error: rsErr } = await admin.from('registration_settings')
    .select('*').eq('event_id', competition.event_id).maybeSingle()
  if (rsErr) throw rsErr
  if (!settings || settings.state === 'draft') return { response: json(NOT_FOUND, 404, req) }
  if (!(await clubRegistrationEnabled(admin, settings.club_id))) return { response: json(NOT_FOUND, 404, req) }

  // Early answers; the RPC re-checks all of them under its locks.
  if (settings.state !== 'published' || competition.hidden_at) return { response: refusal('closed', req) }
  const priced = pricing(settings)
  if (priced) return { response: refusal(priced, req, {}, refusals) }
  const window = settings.opens_at && settings.closes_at
    ? isOpen({ opensAt: settings.opens_at, closesAt: settings.closes_at })
    : 'not_yet'
  if (window === 'not_yet') return { response: refusal('not_open', req) }
  if (window === 'closed') return { response: refusal('closed', req) }

  // ---- people
  const [ageGroups, kidsGroups, consents] = await Promise.all([
    rows(admin.from('age_groups').select('gender, label, min_age, max_age').eq('category_id', categoryId)),
    rows(admin.from('kids_groups').select('id, gender, birth_year_from, birth_year_to').eq('category_id', categoryId)),
    rows(admin.from('event_consents').select('id').eq('event_id', settings.event_id)),
  ])
  const ctx = {
    formFields: settings.form_fields ?? {},
    competition: { minAge: competition.min_age, maxAge: competition.max_age, isKids: competition.is_kids },
    raceDate: settings.event_date,
    reckoning: settings.age_reckoning,
    ageGroups: ageGroups.map((g) => ({ gender: g.gender, label: g.label, minAge: g.min_age, maxAge: g.max_age })),
    kidsGroups: kidsGroups.map((g) => ({ id: g.id, gender: g.gender, minYear: g.birth_year_from, maxYear: g.birth_year_to })),
    now: new Date(),
  }
  const valid = []
  for (const p of people) {
    const r = validatePerson(p, ctx)
    if (!r.ok) return { response: json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: r.errors }, 400, req) }
    valid.push(r.value)
  }
  if (new Set(valid.map((p) => p.email)).size !== valid.length) return { response: refusal('duplicate', req) }

  // ---- consents: every event consent and the LESZY.RUN service regulamin
  const consentIds = consents.map((c) => c.id)
  if (serviceRegulamin !== true || !Array.isArray(acceptedConsentIds) || !sameSet(acceptedConsentIds, consentIds)) {
    return { response: json({ error: REFUSALS.consents_changed[1], code: 'consents_required' }, 400, req) }
  }

  // ---- who registers: a retired address never does (spec 13.3)
  const email = valid[0].email
  for (const p of valid) {
    if (await isEmailRetired(admin, p.email)) {
      return { response: json({ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' }, 403, req) }
    }
  }

  for (const t of throttles(email)) {
    const throttle = await checkAndIncrement(admin, t.key, t.limit, { failOpen: true, windowSeconds: t.windowSeconds })
    if (!throttle.allowed) {
      return {
        response: json({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }, 429, req,
          { 'retry-after': String(throttle.retryAfterSec) }),
      }
    }
  }

  let profileId
  let cookie = null
  const session = await getSession(req, admin)
  if (session && session.email?.toLowerCase() === email) {
    profileId = session.userId
  } else {
    if (!code) return { response: json({ error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }, 401, req) }
    const verified = await verifyCodeAndOpenSession(admin, { email, code })
    if (!verified.ok) {
      const extra = verified.retryAfterSec ? { 'retry-after': String(verified.retryAfterSec) } : {}
      return {
        response: json({ error: verified.error, ...(verified.code ? { code: verified.code } : {}) }, verified.status, req, extra),
      }
    }
    profileId = verified.profile.id
    cookie = verified.cookie
  }

  return {
    competition,
    settings,
    people: valid,
    consentIds,
    email,
    profileId,
    withCookie: cookie ? { 'Set-Cookie': cookie } : {},
  }
}
