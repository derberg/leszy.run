// Wizard sections: what an organizer may write, per section. Plain ESM, no
// runtime APIs: runs in Deno (save-registration-section) and in the browser.
//
// validateSection(section, value, { state, eventDate }) checks one section's
// value against its allow-list and returns the snake_case shape the
// save_registration_section RPC applies. Scalar sections are patches: only the
// keys sent are written. Lists (competition items, office hours, groups,
// custom consents) are the whole list. Required-ness is the publish
// checklist's job (Task 5), so a draft may hold blanks. `eventDate` is the
// stored event date (an extra's „Zamówienia do” and the transfer window need it), and
// `opensAt` / `closesAt` the stored registration window, as timestamps: price tiers are
// checked against its Warsaw days (Plan 7). `teamCategoryIds`
// lists the event's team competitions, as the event will be once staged changes
// apply: the form section's leg order is refused for any other competition.

import { isValidSlug } from './slug.js'
import { registrationWindow, warsawToday } from './dates.js'
import { MAX_PEOPLE_PER_REQUEST, MIN_TEAM_SIZE } from './flags.js'
import { validateTiers } from './pricing.js'

export const SECTIONS = ['basics', 'office', 'competitions', 'categories', 'timing', 'form', 'payments', 'extras']

const UNKNOWN = 'Nieznane pole.'
const PRICE_MESSAGE = 'Podaj cenę w złotych, np. 60 albo 60,50.'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
// Same rule as registration_settings_contact_email_check.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MAX_ITEMS = 50
const MAX_CAPACITY = 100000
const MAX_PRICE_GROSZE = 10_000_000 // 100 000 zł

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isIsoDate(s) {
  const m = typeof s === 'string' && DATE_RE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/** '60' → 6000, '60,5' / '60.50' → 6050; anything else (negative, 3 decimals, text) → null. Integer grosze only. */
export function parsePriceGrosze(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const m = /^(\d{1,7})(?:[,.](\d{1,2}))?$/.exec(String(input).trim())
  if (!m) return null
  const grosze = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return grosze <= MAX_PRICE_GROSZE ? grosze : null
}

// One collector per validation: the first error per field wins, and the
// output is built only from keys that passed.
function collector() {
  const errors = {}
  return {
    errors,
    fail(field, message) { if (!(field in errors)) errors[field] = message },
  }
}

function checkKeys(obj, allowed, c) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) c.fail(key, UNKNOWN)
}

const rules = {
  text: (max, { required = false, emptyMsg } = {}) => (v, field, c) => {
    if (v === null || v === undefined) return required ? (c.fail(field, emptyMsg), undefined) : null
    if (typeof v !== 'string') return c.fail(field, 'Nieprawidłowa wartość.')
    const t = v.trim()
    if (!t) return required ? c.fail(field, emptyMsg) : null
    if (t.length > max) return c.fail(field, `Najwyżej ${max} znaków.`)
    return t
  },
  bool: () => (v, field, c) => (typeof v === 'boolean' ? v : c.fail(field, 'Nieprawidłowa wartość.')),
  date: () => (v, field, c) => (v === null ? null : isIsoDate(v) ? v : c.fail(field, 'Nieprawidłowa data.')),
  time: () => (v, field, c) => (v === null ? null : TIME_RE.test(v ?? '') ? v : c.fail(field, 'Podaj godzinę jako GG:MM.')),
  uuid: () => (v, field, c) => (v === null || v === undefined ? null : UUID_RE.test(String(v)) ? v : c.fail(field, 'Nieprawidłowy identyfikator.')),
  coord: (limit) => (v, field, c) => (v === null ? null
    : typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit ? Math.round(v * 1e6) / 1e6
      : c.fail(field, 'Nieprawidłowa współrzędna.')),
  url: () => (v, field, c) => {
    if (v === null || v === '') return null
    if (typeof v !== 'string' || v.length > 500) return c.fail(field, 'Podaj adres zaczynający się od https://.')
    try {
      const u = new URL(v.trim())
      return u.protocol === 'https:' ? v.trim() : c.fail(field, 'Podaj adres zaczynający się od https://.')
    } catch {
      return c.fail(field, 'Podaj adres zaczynający się od https://.')
    }
  },
  email: () => (v, field, c) => {
    if (v === null || v === '') return null
    const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
    return t.length <= 254 && EMAIL_RE.test(t) ? t : c.fail(field, 'Podaj poprawny adres e-mail.')
  },
  oneOf: (values, message = 'Nieprawidłowa wartość.') => (v, field, c) => (values.includes(v) ? v : c.fail(field, message)),
  int: (min, max, message) => (v, field, c) => (v === null || v === undefined ? null
    : Number.isInteger(v) && v >= min && v <= max ? v : c.fail(field, message)),
}

// Scalar fields of a section: input key → [column, rule].
function applyFields(value, fields, c, out) {
  for (const [key, [column, rule]] of Object.entries(fields)) {
    if (!(key in value)) continue
    const v = rule(value[key], key, c)
    if (v !== undefined) out[column] = v
  }
}

// ---------------------------------------------------------------- basics

const BASICS = {
  name: ['name', rules.text(120, { required: true, emptyMsg: 'Podaj nazwę wydarzenia.' })],
  eventDate: ['event_date', rules.date()],
  firstStartTime: ['first_start_time', rules.time()],
  isCharity: ['is_charity', rules.bool()],
  charityGoal: ['charity_goal', rules.text(300)],
  donationsEnabled: ['donations_enabled', rules.bool()],
  townLabel: ['town_label', rules.text(120)],
  townArea: ['town_area', rules.text(200)],
  placeDetails: ['place_details', rules.text(1000)],
  lat: ['lat', rules.coord(90)],
  lng: ['lng', rules.coord(180)],
  regulaminKind: ['regulamin_kind', (v, f, c) => (v === null ? null : rules.oneOf(['pdf', 'link'])(v, f, c))],
  regulaminUrl: ['regulamin_url', rules.url()],
  regulaminUploadId: ['regulamin_upload_id', rules.uuid()],
  posterUploadId: ['poster_upload_id', rules.uuid()],
  contactEmail: ['contact_email', rules.email()],
}

function validateBasics(value, ctx, c) {
  checkKeys(value, [...Object.keys(BASICS), 'slug', 'opensOn', 'closesOn'], c)
  const out = {}
  applyFields(value, BASICS, c, out)
  if ('slug' in value) {
    if (ctx.state !== 'draft') c.fail('slug', 'Adresu nie można zmienić po publikacji.')
    else if (!isValidSlug(value.slug)) c.fail('slug', 'Adres: małe litery, cyfry i myślniki, od 3 do 80 znaków.')
    else out.slug = value.slug
  }
  // The registration window is two whole Warsaw days, sent and stored together.
  if ('opensOn' in value || 'closesOn' in value) {
    const { opensOn = null, closesOn = null } = value
    if (opensOn === null && closesOn === null) {
      out.opens_at = null
      out.closes_at = null
    } else if (!isIsoDate(opensOn)) {
      c.fail('opensOn', 'Podaj datę otwarcia zapisów.')
    } else if (!isIsoDate(closesOn)) {
      c.fail('closesOn', 'Podaj datę końca zapisów.')
    } else if (closesOn < opensOn) {
      c.fail('closesOn', 'Koniec zapisów musi być po ich otwarciu.')
    } else {
      const { opensAt, closesAt } = registrationWindow({ opensOn, closesOn })
      out.opens_at = opensAt.toISOString()
      out.closes_at = closesAt.toISOString()
    }
  }
  return out
}

// ---------------------------------------------------------------- office

const OFFICE = {
  sameAsEvent: ['office_same_as_event', rules.bool()],
  address: ['office_address', rules.text(300)],
  notes: ['office_notes', rules.text(1000)],
  lat: ['office_lat', rules.coord(90)],
  lng: ['office_lng', rules.coord(180)],
}

function validateOffice(value, ctx, c) {
  checkKeys(value, [...Object.keys(OFFICE), 'hours'], c)
  const out = {}
  applyFields(value, OFFICE, c, out)
  if ('hours' in value) {
    if (!Array.isArray(value.hours) || value.hours.length > MAX_ITEMS) return c.fail('hours', 'Nieprawidłowa lista godzin.')
    out.hours = []
    for (const h of value.hours) {
      if (!isPlainObject(h)) { c.fail('hours', 'Nieprawidłowa lista godzin.'); continue }
      checkKeys(h, ['date', 'from', 'to'], c)
      if (!isIsoDate(h.date)) c.fail('date', 'Nieprawidłowa data.')
      else if (!TIME_RE.test(h.from ?? '')) c.fail('from', 'Podaj godzinę jako GG:MM.')
      else if (!TIME_RE.test(h.to ?? '')) c.fail('to', 'Podaj godzinę jako GG:MM.')
      else if (h.to <= h.from) c.fail('to', 'Godzina zamknięcia musi być po otwarciu.')
      else out.hours.push({ date: h.date, from: h.from, to: h.to })
    }
  }
  return out
}

// ---------------------------------------------------------------- competitions

const ITEM_KEYS = ['categoryId', 'name', 'kind', 'discipline', 'distanceLabel', 'startTime', 'capacity',
  'minAge', 'maxAge', 'isKids', 'timed', 'gpxUploadId', 'price', 'prices', 'teamMin', 'teamMax']
// After publish a competition is hidden, never deleted (applied by
// „Opublikuj zmiany” only while nobody is registered for it).
const PUBLISHED_ITEM_KEYS = [...ITEM_KEYS, 'hidden']
const TEAM_SIZE_MESSAGE = `Skład: od ${MIN_TEAM_SIZE} do ${MAX_PEOPLE_PER_REQUEST} osób, min ≤ max.`

const isTeamSize = (v) => Number.isInteger(v) && v >= MIN_TEAM_SIZE && v <= MAX_PEOPLE_PER_REQUEST

function validateTeamSize({ teamMin, teamMax }, c) {
  if (!isTeamSize(teamMin)) c.fail('teamMin', TEAM_SIZE_MESSAGE)
  else if (!isTeamSize(teamMax) || teamMax < teamMin) c.fail('teamMax', TEAM_SIZE_MESSAGE)
  else return { team_min: teamMin, team_max: teamMax }
  return { team_min: null, team_max: null }
}

// A tiered competition's prices: one per listed tier, keyed by the tier's id or `new:<index>` for a
// tier the save creates (D7-4). Anything else, a missing or extra key included, is one error.
function tieredPrices(prices, tierKeys, c) {
  if (!isPlainObject(prices)) return c.fail('prices', PRICE_MESSAGE)
  const keys = Object.keys(prices)
  if (keys.length !== tierKeys.length || !tierKeys.every((k) => k in prices)) return c.fail('prices', PRICE_MESSAGE)
  const out = {}
  for (const k of tierKeys) {
    const grosze = parsePriceGrosze(prices[k])
    if (grosze === null) return c.fail('prices', PRICE_MESSAGE)
    out[k] = grosze
  }
  return out
}

function validateItem(item, pricingMode, ctx, c, tierKeys) {
  if (!isPlainObject(item)) return c.fail('items', 'Nieprawidłowa konkurencja.')
  checkKeys(item, ctx.state === 'draft' ? ITEM_KEYS : PUBLISHED_ITEM_KEYS, c)
  const name = rules.text(120, { required: true, emptyMsg: 'Podaj nazwę konkurencji.' })(item.name, 'name', c)
  const kind = rules.oneOf(['individual', 'team'])(item.kind ?? 'individual', 'kind', c)
  const discipline = item.discipline == null ? null : rules.oneOf(['run', 'nw'])(item.discipline, 'discipline', c)
  const capacity = Number.isInteger(item.capacity) && item.capacity >= 1 && item.capacity <= MAX_CAPACITY ? item.capacity
    : c.fail('capacity', Number.isInteger(item.capacity) && item.capacity < 1 ? 'Limit musi być większy od zera.' : 'Podaj limit miejsc.')
  const minAge = rules.int(0, 120, 'Nieprawidłowy wiek.')(item.minAge, 'minAge', c)
  const maxAge = rules.int(0, 120, 'Nieprawidłowy wiek.')(item.maxAge, 'maxAge', c)
  if (Number.isInteger(minAge) && Number.isInteger(maxAge) && maxAge < minAge) c.fail('maxAge', 'Wiek „do” musi być co najmniej równy „od”.')
  const isKids = item.isKids === undefined ? false : rules.bool()(item.isKids, 'isKids', c)
  const timed = item.timed === undefined ? true : rules.bool()(item.timed, 'timed', c)
  let price = null
  if (pricingMode === 'fixed') {
    price = parsePriceGrosze(item.price)
    if (price === null) c.fail('price', PRICE_MESSAGE)
  }
  const prices = pricingMode === 'tiered' && tierKeys ? tieredPrices(item.prices, tierKeys, c) : undefined
  const hidden = ctx.state !== 'draft' && 'hidden' in item ? rules.bool()(item.hidden, 'hidden', c) : undefined
  return {
    ...(typeof hidden === 'boolean' ? { hidden } : {}),
    category_id: rules.uuid()(item.categoryId, 'categoryId', c) ?? null,
    name: name ?? null,
    kind: kind ?? 'individual',
    discipline: discipline ?? null,
    distance_label: rules.text(40)(item.distanceLabel ?? null, 'distanceLabel', c) ?? null,
    start_time: rules.time()(item.startTime ?? null, 'startTime', c) ?? null,
    capacity: capacity ?? null,
    min_age: minAge ?? null,
    max_age: maxAge ?? null,
    is_kids: isKids ?? false,
    timed: timed ?? true,
    gpx_upload_id: rules.uuid()(item.gpxUploadId, 'gpxUploadId', c) ?? null,
    price,
    ...(prices ? { prices } : {}),
    // A size sent with an individual competition (the row was switched back) is dropped.
    ...(kind === 'team' ? validateTeamSize(item, c) : { team_min: null, team_max: null }),
  }
}

// The Warsaw days of the stored window, as validateTiers compares them: the first day open and the
// last day open (closes_at is the Warsaw midnight after it).
function windowDays(ctx) {
  const at = (iso, shift) => (iso && !Number.isNaN(Date.parse(iso)) ? warsawToday(new Date(Date.parse(iso) + shift)) : undefined)
  return { opensOn: at(ctx.opensAt, 0), closesOn: at(ctx.closesAt, -1) }
}

// `tiers` of a tiered save: [{ id?, endsOn|null }] in the grid's order, checked by validateTiers
// against the window's Warsaw days. → { tiers: [{ id, ends_on }], keys } or undefined.
function validateTierList(tiers, ctx, c) {
  if (!Array.isArray(tiers)) return c.fail('tiers', 'Od 1 do 5 progów cenowych.')
  if (tiers.some((t) => !isPlainObject(t))) return c.fail('tiers', 'Nieprawidłowy próg cenowy.')
  for (const t of tiers) checkKeys(t, ['id', 'endsOn'], c)
  const ids = tiers.map((t) => rules.uuid()(t.id, 'id', c) ?? null)
  if (ids.some((id) => id === undefined)) return undefined
  const given = ids.filter(Boolean)
  if (new Set(given).size !== given.length) return c.fail('tiers', 'Ten sam próg występuje dwa razy.')
  const checked = validateTiers(tiers.map((t) => ({ endsOn: t.endsOn ?? null })), windowDays(ctx))
  if (!checked.ok) return c.fail('tiers', checked.errors.tiers)
  return {
    tiers: tiers.map((t, i) => ({ id: ids[i], ends_on: t.endsOn ?? null })),
    keys: ids.map((id, i) => id ?? `new:${i}`),
  }
}

function validateCompetitions(value, ctx, c) {
  checkKeys(value, ['pricingMode', 'items', 'tiers'], c)
  const pricingMode = value.pricingMode
  if (!['free', 'fixed', 'tiered'].includes(pricingMode)) c.fail('pricingMode', 'Wybierz rodzaj opłaty.')
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    c.fail('items', 'Nieprawidłowa lista konkurencji.')
    return {}
  }
  const ids = value.items.map((i) => i?.categoryId).filter(Boolean)
  if (new Set(ids).size !== ids.length) c.fail('categoryId', 'Ta sama konkurencja występuje dwa razy.')
  // Tiers only mean something for tiered pricing: sent with fixed or free they are dropped, as the
  // wizard keeps the grid while the organizer flips the fee box.
  const tiered = pricingMode === 'tiered' ? validateTierList(value.tiers, ctx, c) : undefined
  const items = value.items.map((item) => validateItem(item, pricingMode, ctx, c, tiered?.keys))
  return { pricing_mode: pricingMode, ...(tiered ? { tiers: tiered.tiers } : {}), items }
}

// ---------------------------------------------------------------- categories

function validateAgeGroup(g, c) {
  if (!isPlainObject(g)) return c.fail('ageGroups', 'Nieprawidłowa kategoria.')
  checkKeys(g, ['id', 'categoryId', 'gender', 'label', 'minAge', 'maxAge'], c)
  const out = {
    id: rules.uuid()(g.id, 'id', c) ?? null,
    category_id: UUID_RE.test(String(g.categoryId)) ? g.categoryId : c.fail('categoryId', 'Wybierz konkurencję.'),
    gender: rules.oneOf(['M', 'K'])(g.gender, 'gender', c),
    label: rules.text(40, { required: true, emptyMsg: 'Podaj nazwę kategorii.' })(g.label, 'label', c),
    min_age: Number.isInteger(g.minAge) && g.minAge >= 0 && g.minAge <= 120 ? g.minAge : c.fail('minAge', 'Nieprawidłowy wiek.'),
    max_age: rules.int(0, 120, 'Nieprawidłowy wiek.')(g.maxAge ?? null, 'maxAge', c) ?? null,
  }
  if (Number.isInteger(out.min_age) && Number.isInteger(out.max_age) && out.max_age < out.min_age) {
    c.fail('maxAge', 'Wiek „do” musi być co najmniej równy „od”.')
  }
  return out
}

function validateKidsGroup(g, c) {
  if (!isPlainObject(g)) return c.fail('kidsGroups', 'Nieprawidłowa grupa.')
  checkKeys(g, ['id', 'categoryId', 'label', 'birthYearFrom', 'birthYearTo', 'gender', 'distanceLabel'], c)
  const year = (v, field) => (Number.isInteger(v) && v >= 1900 && v <= 2200 ? v : c.fail(field, 'Nieprawidłowy rocznik.'))
  const out = {
    id: rules.uuid()(g.id, 'id', c) ?? null,
    category_id: UUID_RE.test(String(g.categoryId)) ? g.categoryId : c.fail('categoryId', 'Wybierz konkurencję.'),
    label: rules.text(60, { required: true, emptyMsg: 'Podaj nazwę grupy.' })(g.label, 'label', c),
    birth_year_from: year(g.birthYearFrom, 'birthYearFrom'),
    birth_year_to: year(g.birthYearTo, 'birthYearTo'),
    gender: g.gender == null ? null : rules.oneOf(['M', 'K'])(g.gender, 'gender', c),
    distance_label: rules.text(40)(g.distanceLabel ?? null, 'distanceLabel', c) ?? null,
  }
  if (Number.isInteger(out.birth_year_from) && Number.isInteger(out.birth_year_to) && out.birth_year_to < out.birth_year_from) {
    c.fail('birthYearTo', 'Rocznik „do” musi być co najmniej równy „od”.')
  }
  return out
}

function validateCategories(value, ctx, c) {
  checkKeys(value, ['ageReckoning', 'ageGroups', 'kidsGroups'], c)
  const out = {}
  if ('ageReckoning' in value) {
    const v = rules.oneOf(['race_day', 'year_end'])(value.ageReckoning, 'ageReckoning', c)
    if (v !== undefined) out.age_reckoning = v
  }
  for (const [key, column, one, max] of [
    ['ageGroups', 'age_groups', validateAgeGroup, 400],
    ['kidsGroups', 'kids_groups', validateKidsGroup, 100],
  ]) {
    if (!(key in value)) continue
    if (!Array.isArray(value[key]) || value[key].length > max) { c.fail(key, 'Nieprawidłowa lista.'); continue }
    out[column] = value[key].map((g) => one(g, c))
  }
  return out
}

// ---------------------------------------------------------------- timing

const TIMING = {
  timingCompany: ['timing_company', rules.text(120)],
  resultsUrl: ['results_url', rules.url()],
  liveResultsUrl: ['live_results_url', rules.url()],
}

function validateTiming(value, ctx, c) {
  checkKeys(value, [...Object.keys(TIMING), 'timingMode'], c)
  const out = {}
  if ('timingMode' in value) {
    if (ctx.state !== 'draft') c.fail('timingMode', 'Pomiaru czasu nie można zmienić po publikacji.')
    else {
      const v = rules.oneOf(['leszyrun', 'external', 'none'])(value.timingMode, 'timingMode', c)
      if (v !== undefined) out.timing_mode = v
    }
  }
  applyFields(value, TIMING, c, out)
  return out
}

// ---------------------------------------------------------------- form

// The switchable runner fields and their default mode. The phone is not one
// of them: it is always required (P2-R32). A `phone` key from before that
// ruling (a stored form_fields read back by the wizard) is accepted and
// dropped, never stored. Nationality is off unless asked for (P2-R31).
export const FORM_FIELD_DEFAULTS = Object.freeze({ city: 'optional', club: 'optional', ice: 'optional', nationality: 'off' })
const FORM_FIELDS = Object.keys(FORM_FIELD_DEFAULTS)
const RETIRED_FORM_FIELDS = ['phone']

function validateForm(value, ctx, c) {
  checkKeys(value, ['formFields', 'consents', 'legOrder'], c)
  const out = {}
  if ('legOrder' in value) {
    const teams = new Set(ctx.teamCategoryIds ?? [])
    const entries = isPlainObject(value.legOrder) ? Object.entries(value.legOrder) : null
    if (!entries || entries.some(([, on]) => typeof on !== 'boolean')) c.fail('legOrder', 'Nieprawidłowa wartość.')
    else if (entries.some(([id]) => !teams.has(id))) c.fail('legOrder', 'Kolejność zmian ustawisz tylko w konkurencji drużynowej.')
    else out.leg_order = value.legOrder
  }
  if ('formFields' in value) {
    if (!isPlainObject(value.formFields)) c.fail('formFields', 'Nieprawidłowa wartość.')
    else {
      checkKeys(value.formFields, [...FORM_FIELDS, ...RETIRED_FORM_FIELDS], c)
      const ff = {}
      for (const f of FORM_FIELDS) {
        const v = rules.oneOf(['required', 'optional', 'off'])(value.formFields[f] ?? FORM_FIELD_DEFAULTS[f], f, c)
        if (v !== undefined) ff[f] = v
      }
      out.form_fields = ff
    }
  }
  if ('consents' in value) {
    if (!Array.isArray(value.consents) || value.consents.length > 20) c.fail('consents', 'Nieprawidłowa lista zgód.')
    else {
      out.consents = value.consents.map((k) => {
        if (!isPlainObject(k)) return c.fail('consents', 'Nieprawidłowa zgoda.')
        checkKeys(k, ['id', 'text'], c)
        return {
          id: rules.uuid()(k.id, 'id', c) ?? null,
          text: rules.text(500, { required: true, emptyMsg: 'Podaj treść zgody.' })(k.text, 'text', c),
        }
      })
      // One entry per consent: a repeated id would let a list keep an accepted
      // text in one entry and rewrite it in the other (consent_locked, P2-R30).
      const ids = out.consents.map((k) => k?.id).filter(Boolean)
      if (new Set(ids).size !== ids.length) c.fail('consents', 'Ta sama zgoda występuje dwa razy.')
    }
  }
  return out
}

// ---------------------------------------------------------------- payments

// How long a runner has to pay: 24 hours, 7 days, 14 days, or „do końca zapisów”
// (paymentWindowUntilClose: expires_at = closes_at; the hours are then kept but
// unused, so switching back restores them). The payout
// account is not part of this section: only the club owner sets it, through
// update-event-payout (ruling P3-R1).
export const PAYMENT_WINDOW_HOURS = Object.freeze([24, 168, 336])

const TRANSFER_UNTIL_MESSAGE = 'Przekazanie możliwe najpóźniej dzień przed zawodami.'

/** The calendar day before an ISO date. */
function dayBefore(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

// „Przekazanie pakietu”: allowed or not, and the last Warsaw day a runner may hand the package on,
// at the latest the day before the race (ruling 4). The fee is not a field: it stays 0 (ruling 1).
function validateTransfer(value, ctx, c, out) {
  if ('transferEnabled' in value) {
    if (typeof value.transferEnabled === 'boolean') out.transfer_enabled = value.transferEnabled
    else c.fail('transferEnabled', 'Nieprawidłowa wartość.')
  }
  if ('transferUntil' in value) {
    const v = value.transferUntil
    if (v === null) out.transfer_until = null
    else if (!isIsoDate(v)) c.fail('transferUntil', 'Nieprawidłowa data.')
    else if (ctx.eventDate && v > dayBefore(ctx.eventDate)) c.fail('transferUntil', TRANSFER_UNTIL_MESSAGE)
    else out.transfer_until = v
  }
  if (value.transferEnabled === true && !(value.transferUntil && isIsoDate(value.transferUntil))) {
    c.fail('transferUntil', 'Podaj, do kiedy można przekazać pakiet.')
  }
}

function validatePayments(value, ctx, c) {
  checkKeys(value, ['paymentWindowHours', 'paymentWindowUntilClose', 'transferEnabled', 'transferUntil'], c)
  const out = {}
  validateTransfer(value, ctx, c, out)
  if ('paymentWindowHours' in value) {
    const v = rules.oneOf(PAYMENT_WINDOW_HOURS, 'Wybierz czas na opłacenie zgłoszenia.')(value.paymentWindowHours, 'paymentWindowHours', c)
    if (v !== undefined) out.payment_window_hours = v
  }
  if ('paymentWindowUntilClose' in value) {
    if (typeof value.paymentWindowUntilClose === 'boolean') out.payment_window_until_close = value.paymentWindowUntilClose
    else c.fail('paymentWindowUntilClose', 'Wybierz czas na opłacenie zgłoszenia.')
  }
  return out
}

// ---------------------------------------------------------------- extras

// Dodatki (A5b): items the runner buys with the entry, each with variants and a stock. The list is
// the whole list. „Bez limitu” is written as MAX_STOCK (§4.8), never null. An empty list removes
// every extra. After publish the locks (sold variants, ruling 10) are the database's.
export const MAX_EXTRAS = 20
export const MAX_VARIANTS = 20
export const MAX_STOCK = 100000
const STOCK_MESSAGE = `Limit sztuk: od 0 do ${MAX_STOCK.toLocaleString('pl-PL')}.`

function validateVariant(v, c) {
  if (!isPlainObject(v)) return c.fail('variants', 'Nieprawidłowy wariant.')
  checkKeys(v, ['id', 'label', 'stock'], c)
  return {
    id: rules.uuid()(v.id, 'id', c) ?? null,
    label: rules.text(60, { required: true, emptyMsg: 'Podaj nazwę wariantu.' })(v.label, 'label', c) ?? null,
    stock: Number.isInteger(v.stock) && v.stock >= 0 && v.stock <= MAX_STOCK ? v.stock : c.fail('stock', STOCK_MESSAGE),
  }
}

function validateExtra(x, ctx, c) {
  if (!isPlainObject(x)) return c.fail('items', 'Nieprawidłowy dodatek.')
  checkKeys(x, ['id', 'name', 'imageUploadId', 'price', 'orderUntil', 'categoryIds', 'variants'], c)
  const price = parsePriceGrosze(x.price)
  if (price === null) c.fail('price', PRICE_MESSAGE)
  let orderUntil = null
  if (!isIsoDate(x.orderUntil)) c.fail('orderUntil', 'Podaj datę, do której przyjmujesz zamówienia.')
  else if (ctx.eventDate && x.orderUntil > ctx.eventDate) c.fail('orderUntil', 'Zamówienia najpóźniej w dniu zawodów.')
  else orderUntil = x.orderUntil
  const categoryIds = x.categoryIds ?? []
  let categories = []
  if (!Array.isArray(categoryIds) || categoryIds.length > MAX_ITEMS || categoryIds.some((id) => !UUID_RE.test(String(id)))) {
    c.fail('categoryIds', 'Wybierz konkurencje z listy.')
  } else {
    categories = [...new Set(categoryIds.map((id) => id.toLowerCase()))]
  }
  let variants = []
  if (!Array.isArray(x.variants) || x.variants.length < 1 || x.variants.length > MAX_VARIANTS) {
    c.fail('variants', `Od 1 do ${MAX_VARIANTS} wariantów.`)
  } else {
    variants = x.variants.map((v) => validateVariant(v, c))
    const ids = variants.map((v) => v?.id).filter(Boolean)
    if (new Set(ids).size !== ids.length) c.fail('variants', 'Ten sam wariant występuje dwa razy.')
  }
  return {
    id: rules.uuid()(x.id, 'id', c) ?? null,
    name: rules.text(80, { required: true, emptyMsg: 'Podaj nazwę dodatku.' })(x.name, 'name', c) ?? null,
    image_upload_id: rules.uuid()(x.imageUploadId, 'imageUploadId', c) ?? null,
    price,
    order_until: orderUntil,
    category_ids: categories,
    variants,
  }
}

function validateExtras(value, ctx, c) {
  checkKeys(value, ['items'], c)
  if (!Array.isArray(value.items) || value.items.length > MAX_EXTRAS) {
    c.fail('items', `Najwyżej ${MAX_EXTRAS} dodatków.`)
    return {}
  }
  const items = value.items.map((x) => validateExtra(x, ctx, c))
  const ids = items.map((x) => x?.id).filter(Boolean)
  if (new Set(ids).size !== ids.length) c.fail('items', 'Ten sam dodatek występuje dwa razy.')
  return { items }
}

const VALIDATORS = {
  basics: validateBasics,
  office: validateOffice,
  competitions: validateCompetitions,
  categories: validateCategories,
  timing: validateTiming,
  form: validateForm,
  payments: validatePayments,
  extras: validateExtras,
}

/**
 * @param {string} section one of SECTIONS
 * @param {object} value the section's input (camelCase)
 * @param {{ state: 'draft'|'published'|'closed', eventDate?: string|null, opensAt?: string|null, closesAt?: string|null, teamCategoryIds?: string[] }} ctx
 * @returns {{ ok: true, value: object } | { ok: false, errors: Record<string, string> }}
 */
export function validateSection(section, value, ctx = { state: 'draft' }) {
  if (!SECTIONS.includes(section)) return { ok: false, errors: { section: 'Nieznana sekcja.' } }
  if (!isPlainObject(value)) return { ok: false, errors: { value: 'Nieprawidłowe dane.' } }
  const c = collector()
  const out = VALIDATORS[section](value, ctx, c)
  if (Object.keys(c.errors).length) return { ok: false, errors: c.errors }
  return { ok: true, value: out }
}
