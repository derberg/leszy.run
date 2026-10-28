// Wizard sections: what an organizer may write, per section. Plain ESM, no
// runtime APIs: runs in Deno (save-registration-section) and in the browser.
//
// validateSection(section, value, { state, eventDate }) checks one section's
// value against its allow-list and returns the snake_case shape the
// save_registration_section RPC applies. Scalar sections are patches: only the
// keys sent are written. Lists (competition items, office hours, groups,
// custom consents) are the whole list. Required-ness is the publish
// checklist's job (Task 5), so a draft may hold blanks. `eventDate` is the
// stored event date, for rules that need it (none in this task).

import { isValidSlug } from './slug.js'
import { registrationWindow } from './dates.js'

export const SECTIONS = ['basics', 'office', 'competitions', 'categories', 'timing', 'form']

const UNKNOWN = 'Nieznane pole.'
const SOON = 'Wkrótce.'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
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
  'minAge', 'maxAge', 'isKids', 'timed', 'gpxUploadId', 'price']

function validateItem(item, pricingMode, c) {
  if (!isPlainObject(item)) return c.fail('items', 'Nieprawidłowa konkurencja.')
  checkKeys(item, ITEM_KEYS, c)
  const name = rules.text(120, { required: true, emptyMsg: 'Podaj nazwę konkurencji.' })(item.name, 'name', c)
  const kind = item.kind ?? 'individual'
  if (kind === 'team') c.fail('kind', SOON)
  else if (kind !== 'individual') c.fail('kind', 'Nieprawidłowa wartość.')
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
    if (price === null) c.fail('price', 'Podaj cenę w złotych, np. 60 albo 60,50.')
  }
  return {
    category_id: rules.uuid()(item.categoryId, 'categoryId', c) ?? null,
    name: name ?? null,
    kind: 'individual',
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
  }
}

function validateCompetitions(value, ctx, c) {
  checkKeys(value, ['pricingMode', 'items'], c)
  const pricingMode = value.pricingMode
  if (pricingMode === 'tiered') c.fail('pricingMode', SOON)
  else if (!['free', 'fixed'].includes(pricingMode)) c.fail('pricingMode', 'Wybierz rodzaj opłaty.')
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    c.fail('items', 'Nieprawidłowa lista konkurencji.')
    return {}
  }
  const ids = value.items.map((i) => i?.categoryId).filter(Boolean)
  if (new Set(ids).size !== ids.length) c.fail('categoryId', 'Ta sama konkurencja występuje dwa razy.')
  const items = value.items.map((item) => validateItem(item, pricingMode, c))
  return { pricing_mode: pricingMode, items }
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

const FORM_FIELDS = ['phone', 'city', 'club', 'ice']

function validateForm(value, ctx, c) {
  checkKeys(value, ['formFields', 'consents'], c)
  const out = {}
  if ('formFields' in value) {
    if (!isPlainObject(value.formFields)) c.fail('formFields', 'Nieprawidłowa wartość.')
    else {
      checkKeys(value.formFields, FORM_FIELDS, c)
      const ff = {}
      for (const f of FORM_FIELDS) {
        const v = rules.oneOf(['required', 'optional', 'off'])(value.formFields[f] ?? 'optional', f, c)
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
    }
  }
  return out
}

const VALIDATORS = {
  basics: validateBasics,
  office: validateOffice,
  competitions: validateCompetitions,
  categories: validateCategories,
  timing: validateTiming,
  form: validateForm,
}

/**
 * @param {string} section one of SECTIONS
 * @param {object} value the section's input (camelCase)
 * @param {{ state: 'draft'|'published'|'closed', eventDate?: string|null }} ctx
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
