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
// its Plan 2 answers (`fields`, no `index`). With `team: true` the body is register-team's: one
// competition, its members a team (normalizeTeamRequest + validateTeam), member 0 the buyer. Deno only
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
import { DPAY_DOWN, PAYMENTS_OFF } from './orderFlow.js'
import { TEAM_NAME_MESSAGE, normalizeTeamRequest, teamSizeMessage, validateTeam } from './team.js'

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
// Per address and per client IP, per hour: a team and an order share one allowance. The IP limit
// is register-free's 20 (fix round 1).
export const ORDER_LIMIT = 10
export const ORDER_IP_LIMIT = 20
const HOUR = 3600
/** prepareRegistration's `throttles` for create-order and register-team. */
export const orderThrottles = (ip) => (email) => [
  ...(ip ? [{ key: `order-ip:${ip}`, limit: ORDER_IP_LIMIT, windowSeconds: HOUR }] : []),
  { key: `order:${email}`, limit: ORDER_LIMIT, windowSeconds: HOUR },
]
// Duplicate answers that say which card (`index`) per buyer per 24 h (I-1): the form needs the
// card, an enumerator needs many. Past the cap a duplicate is answered GROUP_REFUSED, naming none.
export const DUPLICATE_REVEALS_PER_DAY = 5
export const GROUP_REFUSED = 'Nie udało się zapisać tej grupy. Sprawdź dane i spróbuj ponownie.'
// A child has no address field: their duplicate is worded for the person.
export const PERSON_DUPLICATE = 'Ta osoba jest już zapisana na te zawody.'

export const throttled = (req, retryAfterSec, headers = {}) =>
  json({ error: THROTTLED }, 429, req, { ...headers, 'retry-after': String(retryAfterSec) })

// The RPCs' refusals (exception messages) and what the runner reads.
export const REFUSALS = {
  full: [409, 'Brak wolnych miejsc w tej konkurencji.'],
  closed: [409, 'Zapisy są zamknięte.'],
  not_open: [409, 'Zapisy jeszcze się nie rozpoczęły.'],
  not_free: [409, 'Zapisy na te zawody są płatne. Płatności online będą dostępne wkrótce.'],
  duplicate: [409, 'Ten adres e-mail jest już zapisany na te zawody.'],
  consents_changed: [400, 'Zaznacz wymagane zgody.'],
  team_competition: [409, 'W tej konkurencji startują tylko drużyny.'],
}

// create_order's refusals beyond register_free's. create_team_registration raises them too.
export const ORDER_REFUSALS = {
  ...REFUSALS,
  free_event: [409, 'Zapisy na te zawody są bezpłatne.'],
  no_price: [409, 'Ta konkurencja nie ma jeszcze ceny. Spróbuj później.'],
  paying_closed: [409, 'Zapisy z płatnością online kończą się godzinę przed zamknięciem zapisów.'],
  too_many_pending: [409, 'Masz już dwa nieopłacone zgłoszenia na te zawody.'],
  invalid_buyer_email: [400, 'Popraw adres e-mail.'],
  'invalid_amount:total': [400, 'Kwota zamówienia przekracza limit płatności online.'],
}
export const PRICE_CHANGED = 'Cena się zmieniła. Sprawdź podsumowanie.'
export const PENDING_ORDER = 'Masz już nieopłacone zgłoszenie na te zawody.'

export const TEAM_REFUSALS = {
  ...ORDER_REFUSALS,
  full: [409, 'Brak wolnych miejsc dla drużyn.'],
  not_team: [409, 'Ta konkurencja nie jest dla drużyn.'],
  invalid_people: [400, 'Popraw zaznaczone pola.'],
}
const TEAM_NAME_TAKEN = 'Ta nazwa drużyny jest już zajęta.'
const TEAM_TRY_AGAIN = 'Nie udało się zapisać drużyny. Spróbuj ponownie.'

// team_squad_edit's refusals. edits_closed is accept_consent_request's: same answer if a future
// path through the squad editor raises it.
export const SQUAD_REFUSALS = {
  consents_changed: REFUSALS.consents_changed,
  squad_closed: [409, 'Zapisy są zamknięte — skład zmienisz w biurze zawodów.'],
  team_full: [409, 'Skład jest pełny.'],
  captain_fixed: [409, 'Kapitana nie można wymienić.'],
  team_inactive: [409, 'To zgłoszenie nie jest już aktywne.'],
  leg_order_off: [409, 'W tej konkurencji nie ustala się kolejności zmian.'],
  invalid_legs: [409, 'Skład się zmienił. Odśwież stronę i ustaw kolejność jeszcze raz.'],
  not_member: [409, 'Tej osoby nie ma już w składzie. Odśwież stronę.'],
  invalid_op: [422, 'Nie rozpoznano tej zmiany składu.'],
  invalid_people: [422, 'Popraw zaznaczone pola.'],
  edits_closed: [422, 'Po zamknięciu zapisów dane poprawisz w biurze zawodów.'],
}
const SQUAD_TRY_AGAIN = 'Nie udało się zmienić składu. Spróbuj ponownie.'

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

/** validatePerson's context per competition: category_id → context. `compRows` are competitions rows. */
export async function personContexts(admin, settings, compRows) {
  const ids = compRows.map((c) => c.category_id)
  const [ageGroups, kidsGroups] = await Promise.all([
    rows(admin.from('age_groups').select('category_id, gender, label, min_age, max_age').in('category_id', ids)),
    rows(admin.from('kids_groups').select('id, category_id, gender, birth_year_from, birth_year_to').in('category_id', ids)),
  ])
  return new Map(compRows.map((c) => [c.category_id, {
    formFields: settings.form_fields ?? {},
    competition: { minAge: c.min_age, maxAge: c.max_age, isKids: c.is_kids },
    raceDate: settings.event_date,
    reckoning: settings.age_reckoning,
    ageGroups: ageGroups.filter((g) => g.category_id === c.category_id)
      .map((g) => ({ gender: g.gender, label: g.label, minAge: g.min_age, maxAge: g.max_age })),
    kidsGroups: kidsGroups.filter((g) => g.category_id === c.category_id)
      .map((g) => ({ id: g.id, gender: g.gender, minYear: g.birth_year_from, maxYear: g.birth_year_to })),
  }]))
}

/**
 * Runs the shared steps. → { response } for an early answer, or
 * { competitions: Map<categoryId, competition>, competition (the first person's), settings,
 *   people: [{ categoryId, role: self|adult|minor, …validatePerson value }], buyer, buyerName,
 *   consentIds, email (the buyer's address), profileId, withCookie, legacy, teamName }.
 * `pricing(settings)` returns a refusal code (a key of `refusals`) for an event this path does
 * not serve, or null.
 * `throttles(email)` lists the counters to claim: [{ key, limit, windowSeconds }].
 */
export async function prepareRegistration(req, admin, body, { pricing, throttles, refusals = REFUSALS, team = false }) {
  const { acceptedConsentIds, serviceRegulamin, code } = body ?? {}
  const legacy = !team && !Array.isArray(body?.people) // Plan 2's `{ categoryId, person }`
  const teamRequest = team ? normalizeTeamRequest(body) : null
  const group = team
    ? { people: teamRequest.members.map((m) => ({ categoryId: teamRequest.categoryId, person: m.person })), buyer: null }
    : normalizeGroupRequest(body)
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
  if (team && competition.kind !== 'team') return { response: refusal('not_team', req, {}, refusals) }
  const priced = pricing(settings)
  if (priced) return { response: refusal(priced, req, {}, refusals) }
  const window = settings.opens_at && settings.closes_at
    ? isOpen({ opensAt: settings.opens_at, closesAt: settings.closes_at })
    : 'not_yet'
  if (window === 'not_yet') return { response: refusal('not_open', req) }
  if (window === 'closed') return { response: refusal('closed', req) }

  // ---- the group
  const [contexts, consents] = await Promise.all([
    personContexts(admin, settings, compRows),
    rows(admin.from('event_consents').select('id').eq('event_id', settings.event_id)),
  ])
  const now = new Date()

  // Who registers: the body's buyer, otherwise card 1 („Twoje dane”). That address is the
  // `self` of validateGroup, so at most one person is self and it is always the buyer.
  const claimed = (group.buyer ? group.buyer.email : group.people[0].person?.email ?? '')
  const claimedEmail = typeof claimed === 'string' ? claimed.trim().toLowerCase() : ''
  let teamValue = null
  if (team) {
    const validated = validateTeam({ ...teamRequest, categoryId: competition.category_id }, {
      sessionEmail: claimedEmail || null,
      competition: {
        ...contexts.get(competition.category_id),
        teamMin: competition.team_min, teamMax: competition.team_max, legOrderEnabled: competition.leg_order_enabled,
      },
      now,
    })
    if (!validated.ok) {
      return {
        response: json({
          error: validated.groupError ?? 'Popraw zaznaczone pola.',
          code: validated.groupError ? 'invalid_group' : 'invalid_person',
          errors: validated.errors,
          fields: validated.fieldErrors,
        }, 400, req),
      }
    }
    teamValue = validated.value
  }
  const checked = team
    ? { ok: true, value: teamValue.members, buyerEmail: claimedEmail }
    : validateGroup(group, { sessionEmail: claimedEmail || null, competitions: contexts, now })
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
    teamName: teamValue?.teamName ?? null,
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
 * any other message. `team_competition` names the first team competition of the group.
 * `full:<categoryId>` names the competition (the legacy body keeps Plan 2's
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
  // D5-12: a person into a team competition. The group's answer names it, so the form puts the
  // message on the cards in it (final review I-1); the legacy body keeps the bare answer.
  if (msg === 'team_competition') {
    const [status, error] = REFUSALS.team_competition
    if (legacy) return [status, { error, code: msg }]
    const team = people?.map((p) => competitions?.get(String(p.categoryId).toLowerCase())).find((c) => c?.kind === 'team')
    return [status, { error, code: msg, ...(team ? { categoryId: team.category_id } : {}) }]
  }
  return null
}

/**
 * create_team_registration's refusal as the captain's answer → [status, body], or null for an
 * error that is no refusal. A deadlock (40P01; two teams sharing members in opposite order, which
 * no lock serialises) wrote nothing and goes through on a retry. `duplicate:<i>` keeps the daily
 * reveal cap of groupRefusal. `competition` is the competitions row, for the size in the message.
 */
export async function teamRefusal(admin, error, { competition, people, email }) {
  if (error?.code === '40P01') return [409, { error: TEAM_TRY_AGAIN, code: 'try_again' }]
  const msg = error?.message ?? ''
  if (msg === 'not_found') return [404, NOT_FOUND]
  if (msg === 'session_required') return [401, { error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }]
  if (msg === 'team_name_taken') return [409, { error: TEAM_NAME_TAKEN, code: msg, fields: { teamName: TEAM_NAME_TAKEN } }]
  if (msg === 'invalid_team_name') return [400, { error: TEAM_NAME_MESSAGE, code: msg, fields: { teamName: TEAM_NAME_MESSAGE } }]
  if (msg === 'team_size') {
    return [409, { error: teamSizeMessage(competition.team_min, competition.team_max), code: msg }]
  }
  const changed = /^price_changed:(\d+)$/.exec(msg)
  if (changed) {
    const total = Number(changed[1])
    return [409, {
      error: PRICE_CHANGED, code: 'price_changed',
      amounts: { entryPrices: [total], entryTotal: total, extrasTotal: 0, donation: 0, total },
    }]
  }
  if (/^duplicate:\d+$/.test(msg)) {
    const [status, body] = await groupRefusal(admin, msg, { people, legacy: false, email })
    if (body.code !== 'duplicate') return [status, body]
    return [status, { error: PERSON_DUPLICATE, code: 'duplicate', index: body.index, errors: { [body.index]: { email: PERSON_DUPLICATE } } }]
  }
  if (TEAM_REFUSALS[msg]) {
    const [status, text] = TEAM_REFUSALS[msg]
    return [status, { error: text, code: msg }]
  }
  return null
}

/** startPaymentAttempt's `refused` as register-team's answer → [status, body]. */
export function teamAttemptRefusal(refused) {
  if (refused === 'dpay_unconfigured') return [503, { error: PAYMENTS_OFF }]
  if (refused === 'dpay_unavailable') return [502, { error: DPAY_DOWN, code: 'dpay_unavailable' }]
  if (refused === 'full') return [409, { error: TEAM_REFUSALS.full[1], code: 'full' }]
  return [409, { error: REFUSALS.closed[1], code: 'closed' }]
}

/**
 * team_squad_edit's refusal as the captain's answer → [status, body], or null for an error that is
 * no refusal. Somebody who is not the captain never learns the team exists. A duplicate spends the
 * same daily reveal as a sign-up (groupRefusal), because it says a person is registered: past the
 * cap it is GROUP_REFUSED. `person` is the one joining, `email` the captain's.
 */
export async function squadRefusal(admin, error, { person, email }) {
  if (error?.code === '40P01') return [409, { error: SQUAD_TRY_AGAIN, code: 'try_again' }]
  const msg = error?.message ?? ''
  if (msg === 'not_found' || msg === 'not_captain') return [404, NOT_FOUND]
  if (msg === 'duplicate') {
    const [status, { index: _index, ...body }] = await groupRefusal(admin, 'duplicate:0', { people: [person], legacy: false, email })
    return [status, body.code === 'duplicate' && person?.role !== 'minor' ? { ...body, fields: { email: body.error } } : body]
  }
  if (SQUAD_REFUSALS[msg]) {
    const [status, text] = SQUAD_REFUSALS[msg]
    return [status, { error: text, code: msg }]
  }
  return null
}
