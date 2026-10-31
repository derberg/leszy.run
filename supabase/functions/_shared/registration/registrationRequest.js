// What register-free and create-order do before their RPC, in one place and one order:
// the event from the group's competitions (404 for a draft, an unknown competition, two events
// or a disabled club), the early window answers, the group (normalizeGroupRequest +
// validateGroup: roles, every person's fields, guardian consent, at most one self), the consents
// (every event consent, image included, plus the LESZY.RUN service regulamin), the caller's
// throttles (per client IP and per address), a retired buyer address, who registers (the buyer,
// who is the `self` person or the `buyer` of the body: the session must be that address,
// otherwise the e-mail code for it logs them in and sets the cookie), then the buyer's people cap
// and a retired address per added adult. Everything that answers about somebody else's address or registration runs only for a
// verified buyer and behind the throttles (fix round 1, I-1…I-3). The legacy
// `{ categoryId, person }` body is a group of one whose person is the one registering, and keeps
// its Plan 2 answers (`fields`, no `index`). Deno only
// (session, throttle and code verification touch the database through the admin client).
import { getCorsHeaders } from '../cors.js'
import { getSession } from '../session.js'
import { checkAndIncrement } from '../throttle.js'
import { verifyCodeAndOpenSession } from '../verifyCode.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from '../deletedEmails.js'
import { clubRegistrationEnabled } from '../organizer.js'
import { isUuid } from './organizerEvent.js'
import { isOpen } from './dates.js'
import { normalizeGroupRequest, validateGroup } from './group.js'

export function json(body, status, req, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...headers },
  })
}

export const NOT_FOUND = { error: 'Not found' }

const THROTTLED = 'Zbyt wiele prób. Spróbuj ponownie później.'
const DAY = 86400

// Per buyer, per 24 h, shared by register-free and create-order (fix round 1, I-2): people
// claimed, counted per person (a group of 10 takes 10), after the session/code step so nobody
// can spend another address's allowance. A group refused later (full, duplicate) keeps its claim.
export const PEOPLE_PER_DAY = 30
// Duplicate answers that say which card (`index`) per buyer per 24 h (I-1): the form needs the
// card, an enumerator needs many. Past the cap a duplicate is answered GROUP_REFUSED, naming none.
export const DUPLICATE_REVEALS_PER_DAY = 5
export const GROUP_REFUSED = 'Nie udało się zapisać tej grupy. Sprawdź dane i spróbuj ponownie.'
// A child has no address field: their duplicate is worded for the person.
export const PERSON_DUPLICATE = 'Ta osoba jest już zapisana na te zawody.'

const throttled = (req, retryAfterSec, headers = {}) =>
  json({ error: THROTTLED }, 429, req, { ...headers, 'retry-after': String(retryAfterSec) })

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
 * { competitions: Map<categoryId, competition>, competition (the first person's), settings,
 *   people: [{ categoryId, role: self|adult|minor, …validatePerson value }], buyer, buyerName,
 *   consentIds, email (the buyer's address), profileId, withCookie, legacy }.
 * `pricing(settings)` returns a refusal code (a key of `refusals`) for an event this path does
 * not serve, or null.
 * `throttles(email)` lists the counters to claim: [{ key, limit, windowSeconds }].
 */
export async function prepareRegistration(req, admin, body, { pricing, throttles, refusals = REFUSALS }) {
  const { acceptedConsentIds, serviceRegulamin, code } = body ?? {}
  const legacy = !Array.isArray(body?.people) // Plan 2's `{ categoryId, person }`
  const group = normalizeGroupRequest(body)
  if (group.people.length === 0) return { response: json({ error: 'Brak danych osoby.' }, 400, req) }

  // ---- the event, derived from the competitions: every one known and of one event
  const categoryIds = [...new Set(group.people.map((p) => p.categoryId))]
  if (!categoryIds.every(isUuid)) return { response: json(NOT_FOUND, 404, req) }
  // validateGroup and the RPC key competitions by the id as sent; Postgres returns it lowercase.
  group.people.forEach((p) => { p.categoryId = p.categoryId.toLowerCase() })
  const ids = [...new Set(categoryIds.map((c) => c.toLowerCase()))]
  const compRows = await rows(admin.from('competitions').select('*').in('category_id', ids))
  if (compRows.length !== ids.length) return { response: json(NOT_FOUND, 404, req) }
  if (new Set(compRows.map((c) => c.event_id)).size > 1) return { response: json(NOT_FOUND, 404, req) }
  const competitions = new Map(compRows.map((c) => [c.category_id, c]))
  const competition = competitions.get(group.people[0].categoryId)
  const { data: settings, error: rsErr } = await admin.from('registration_settings')
    .select('*').eq('event_id', competition.event_id).maybeSingle()
  if (rsErr) throw rsErr
  if (!settings || settings.state === 'draft') return { response: json(NOT_FOUND, 404, req) }
  if (!(await clubRegistrationEnabled(admin, settings.club_id))) return { response: json(NOT_FOUND, 404, req) }

  // Early answers; the RPC re-checks all of them under its locks.
  if (settings.state !== 'published' || compRows.some((c) => c.hidden_at)) return { response: refusal('closed', req) }
  const priced = pricing(settings)
  if (priced) return { response: refusal(priced, req, {}, refusals) }
  const window = settings.opens_at && settings.closes_at
    ? isOpen({ opensAt: settings.opens_at, closesAt: settings.closes_at })
    : 'not_yet'
  if (window === 'not_yet') return { response: refusal('not_open', req) }
  if (window === 'closed') return { response: refusal('closed', req) }

  // ---- the group
  const [ageGroups, kidsGroups, consents] = await Promise.all([
    rows(admin.from('age_groups').select('category_id, gender, label, min_age, max_age').in('category_id', ids)),
    rows(admin.from('kids_groups').select('id, category_id, gender, birth_year_from, birth_year_to').in('category_id', ids)),
    rows(admin.from('event_consents').select('id').eq('event_id', settings.event_id)),
  ])
  const now = new Date()
  const contexts = new Map(compRows.map((c) => [c.category_id, {
    formFields: settings.form_fields ?? {},
    competition: { minAge: c.min_age, maxAge: c.max_age, isKids: c.is_kids },
    raceDate: settings.event_date,
    reckoning: settings.age_reckoning,
    ageGroups: ageGroups.filter((g) => g.category_id === c.category_id)
      .map((g) => ({ gender: g.gender, label: g.label, minAge: g.min_age, maxAge: g.max_age })),
    kidsGroups: kidsGroups.filter((g) => g.category_id === c.category_id)
      .map((g) => ({ id: g.id, gender: g.gender, minYear: g.birth_year_from, maxYear: g.birth_year_to })),
  }]))

  // Who registers: the body's buyer, otherwise card 1 („Twoje dane”). That address is the
  // `self` of validateGroup, so at most one person is self and it is always the buyer.
  const claimed = (group.buyer ? group.buyer.email : group.people[0].person?.email ?? '')
  const claimedEmail = typeof claimed === 'string' ? claimed.trim().toLowerCase() : ''
  const checked = validateGroup(group, { sessionEmail: claimedEmail || null, competitions: contexts, now })
  if (!checked.ok) {
    if (checked.groupError) return { response: json({ error: checked.groupError, code: 'invalid_group' }, 400, req) }
    const { buyer: buyerErrors, ...perPerson } = checked.errors
    // A `buyer` block only answers a buyer that was sent (m-2): without one, card 1 is the one
    // registering, and its own fields say what is missing.
    const showBuyer = buyerErrors && group.buyer
    return {
      response: json({
        error: 'Popraw zaznaczone pola.', code: 'invalid_person',
        ...(legacy ? {} : { people: perPerson }),
        ...(showBuyer ? { buyer: buyerErrors } : {}),
        fields: perPerson[0] ?? {},
      }, 400, req),
    }
  }
  const people = checked.value
  const email = checked.buyerEmail
  const self = people.filter((p) => p.role === 'self')
  // validateGroup's guarantees, kept here as the request layer's own check (the RPC does not):
  // at most one self, and the self is the buyer.
  if (self.length > 1 || (self.length === 1 && self[0].email !== email) || email !== claimedEmail) {
    return { response: json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: {} }, 400, req) }
  }
  const buyerName = self.length
    ? `${self[0].firstName} ${self[0].lastName}`
    : `${group.buyer.firstName} ${group.buyer.lastName}`
  const buyerFirstName = self.length ? self[0].firstName : group.buyer.firstName

  // ---- consents: every event consent and the LESZY.RUN service regulamin
  const consentIds = consents.map((c) => c.id)
  if (serviceRegulamin !== true || !Array.isArray(acceptedConsentIds) || !sameSet(acceptedConsentIds, consentIds)) {
    return { response: json({ error: REFUSALS.consents_changed[1], code: 'consents_required' }, 400, req) }
  }

  for (const t of throttles(email)) {
    const throttle = await checkAndIncrement(admin, t.key, t.limit, { failOpen: true, windowSeconds: t.windowSeconds })
    if (!throttle.allowed) return { response: throttled(req, throttle.retryAfterSec) }
  }

  // ---- a retired address never registers (spec 13.3). The buyer's own address is answered here,
  // behind the throttles: it is the address the code goes to, and auth-request-code says the same
  // about it (Plan 2's W-35). Everybody else's is checked after the session step, below.
  const selfIndex = people.findIndex((p) => p.role === 'self')
  if (await isEmailRetired(admin, email)) {
    return {
      response: json({
        error: RETIRED_EMAIL_MESSAGE, code: 'email_retired', ...(legacy || selfIndex < 0 ? {} : { index: selfIndex }),
      }, 403, req),
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
  const withCookie = cookie ? { 'Set-Cookie': cookie } : {}

  // ---- the buyer's people cap: one slot per person (I-2). Fails open like the throttles above.
  const claims = await Promise.all(people.map(() =>
    checkAndIncrement(admin, `register-people:${email}`, PEOPLE_PER_DAY, { failOpen: true, windowSeconds: DAY })))
  const refused = claims.find((c) => !c.allowed)
  if (refused) return { response: throttled(req, refused.retryAfterSec, withCookie) }

  // ---- a retired added adult never registers (ruling 8: they could never log in). After the
  // session step (I-3): only a verified buyer learns that an address they typed is retired.
  for (const [index, p] of people.entries()) {
    if (p.email && p.email !== email && await isEmailRetired(admin, p.email)) {
      return {
        response: json({ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired', ...(legacy ? {} : { index }) }, 403, req, withCookie),
      }
    }
  }

  return {
    competitions,
    competition,
    settings,
    people,
    buyerName,
    buyerFirstName,
    consentIds,
    email,
    profileId,
    legacy,
    withCookie,
  }
}

/** The RPC's people: the role and fields the SQL reads, nothing else. */
export function rpcPeople(people) {
  return people.map(({ isMinor, ...p }) => p)
}

/**
 * The answer to a `full` for a group whose competition the RPC did not name (add_payment_attempt):
 * the first competition, in category_id order like create_order, where the confirmed entries plus
 * this group's people pass the limit (m-5). `comps` are competitions rows (category_id, name,
 * taken, capacity); `people` carry categoryId. The legacy body keeps Plan 3's answer.
 */
export function fullRefusal(comps, people, { legacy }) {
  if (legacy) return { error: REFUSALS.full[1], code: 'full' }
  const wanted = new Map()
  for (const p of people) wanted.set(p.categoryId, (wanted.get(p.categoryId) ?? 0) + 1)
  const over = [...comps].sort((a, b) => (a.category_id < b.category_id ? -1 : 1))
    .find((c) => wanted.has(c.category_id) && c.taken + wanted.get(c.category_id) > c.capacity)
  if (!over) return { error: 'Brak wolnych miejsc.', code: 'full' }
  return { error: `Brak wolnych miejsc w konkurencji ${over.name}.`, code: 'full', categoryId: over.category_id }
}

/**
 * The group RPCs' refusals that carry a person or a competition (D4-6), as answers; null for
 * any other message. `full:<categoryId>` names the competition (the legacy body keeps Plan 2's
 * „w tej konkurencji”). `duplicate:<i>` points at the person, worded for an address or, for a
 * child, for the person, while the buyer (`email`) has duplicate answers left today; past
 * DUPLICATE_REVEALS_PER_DAY it is GROUP_REFUSED with no index (I-1). The legacy body keeps Plan 2's
 * answer: its one person is the verified buyer, so it tells nobody anything about somebody else.
 */
export async function groupRefusal(admin, msg, { competitions, people, legacy, email }) {
  const full = /^full:([0-9a-f-]{36})$/i.exec(msg)
  if (full) {
    const categoryId = full[1].toLowerCase()
    if (legacy) return [409, { error: REFUSALS.full[1], code: 'full' }]
    const name = competitions.get(categoryId)?.name
    return [409, { error: name ? `Brak wolnych miejsc w konkurencji ${name}.` : REFUSALS.full[1], code: 'full', categoryId }]
  }
  const dup = /^duplicate:(\d+)$/.exec(msg)
  if (dup) {
    if (legacy) return [409, { error: REFUSALS.duplicate[1], code: 'duplicate' }]
    const reveal = await checkAndIncrement(admin, `register-duplicate:${email}`, DUPLICATE_REVEALS_PER_DAY, { windowSeconds: DAY })
    if (!reveal.allowed) return [409, { error: GROUP_REFUSED, code: 'refused' }]
    const index = Number(dup[1])
    const error = people?.[index]?.role === 'minor' ? PERSON_DUPLICATE : REFUSALS.duplicate[1]
    return [409, { error, code: 'duplicate', index }]
  }
  if (msg === 'mixed_events') return [404, NOT_FOUND]
  return null
}
