// The public registration event page (RA1, RA1b) as display values, from the
// raw snapshot that registration_raw / registration_public return.
//
// eventPageModel(raw, now): raw must already have its file URLs
// (withFileUrls in eventFiles.js). mergePending(raw, pending): the organizer
// preview's staged changes laid over the raw, before withFileUrls. Pure: the
// page, the preview and the unit tests call the same functions.

// The Warsaw calendar date (YYYY-MM-DD) of an instant; same rule as
// warsawToday() in _shared/registration/dates.js, kept here so this module has
// no imports from there.
import { pluralPl } from './plural.js'

const warsawDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
const warsawToday = (d) => warsawDate.format(d)

const WEEKDAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota']
const WEEKDAYS_SHORT = ['ndz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob']
const DAY_MS = 24 * 3600 * 1000

function ymd(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return { y, m, d, utc: Date.UTC(y, m - 1, d) }
}

const weekday = (isoDate) => new Date(ymd(isoDate).utc).getUTCDay()

/** '08:00' → '8:00' */
const hm = (t) => (t ? t.replace(/^0(\d:)/, '$1') : null)

/** 6000 → '60 zł', 6050 → '60,50 zł' */
function money(grosze) {
  const zl = grosze / 100
  return `${Number.isInteger(zl) ? zl : zl.toFixed(2).replace('.', ',')} zł`
}

const years = (n) => (n === 1 ? 'roku' : 'lat')

function ageLabel(minAge, maxAge) {
  if (minAge != null && maxAge != null) return `${minAge}–${maxAge} lat`
  if (minAge != null) return `od ${minAge} ${years(minAge)}`
  if (maxAge != null) return `do ${maxAge} ${years(maxAge)}`
  return null
}

/** 'soon' before opensAt, 'open' inside the window, else 'closed'. A draft
 * (organizer preview) follows its dates, as it will once published. */
function windowState(raw, now) {
  if (raw.state === 'closed' || !raw.opensAt || !raw.closesAt) return 'closed'
  const t = now.getTime()
  if (t < Date.parse(raw.opensAt)) return 'soon'
  if (t >= Date.parse(raw.closesAt)) return 'closed'
  return 'open'
}

/** Warsaw days from today until the window closes: the last day counts as one. */
function daysLeftLabel(raw, now) {
  const n = Math.round((ymd(warsawToday(new Date(raw.closesAt))).utc - ymd(warsawToday(now)).utc) / DAY_MS)
  return n === 1 ? '1 dzień' : `${n} dni`
}

// RA1's line of a team competition. The count is teams, the limit too: a team takes one place.
function teamLine(c) {
  if (c.kind !== 'team') return null
  const sized = c.teamMin != null && c.teamMax != null
  const size = !sized ? null : c.teamMin === c.teamMax ? `Drużyny ${c.teamMin}-osobowe` : `Drużyny ${c.teamMin}–${c.teamMax} osób`
  const price = c.priceGrosze == null ? null : c.priceGrosze === 0 ? 'Bezpłatne' : `${money(c.priceGrosze)} / drużyna`
  const limit = Number.isInteger(c.capacity) && c.capacity >= 0 ? pluralPl(c.capacity, 'DRUŻYNA', 'DRUŻYNY', 'DRUŻYN') : 'DRUŻYN'
  return [size, price, `${c.taken} / ${c.capacity} ${limit}`].filter(Boolean).join(' · ')
}

const DM = (iso) => `${ymd(iso).d}.${ymd(iso).m}`

// The extras a competition offers (no competition named = every one), for RA1 and the form. A
// variant with nothing left stays, as „brak”.
function extrasFor(extras, categoryId) {
  return (extras ?? [])
    .filter((x) => !x.categoryIds?.length || x.categoryIds.includes(categoryId))
    .map((x) => ({
      id: x.id,
      name: x.name,
      description: x.description ?? null,
      imageUrl: x.imageUrl ?? null,
      priceLabel: money(x.price),
      orderUntil: x.orderUntil,
      orderUntilLabel: x.orderUntil ? `zamówienia do ${DM(x.orderUntil)}` : null,
      variants: (x.variants ?? []).map((v) => ({
        id: v.id, label: v.label, left: v.left, soldOut: v.left <= 0, leftLabel: v.left <= 0 ? 'brak' : null,
      })),
    }))
}

function competitionRow(c, win, extras) {
  const age = ageLabel(c.minAge, c.maxAge)
  const byAge = c.isKids && c.kidsGroups?.some((g) => g.distanceLabel) ? 'dystans wg wieku' : null
  const full = c.taken >= c.capacity
  return {
    categoryId: c.categoryId,
    name: c.name,
    kind: c.kind === 'team' ? 'team' : 'individual',
    startLabel: [c.startTime ? `start ${hm(c.startTime)}` : null, age, byAge].filter(Boolean).join(' · '),
    ageLabel: age,
    priceLabel: c.priceGrosze == null ? null : c.priceGrosze === 0 ? 'Bezpłatne' : money(c.priceGrosze),
    teamLine: teamLine(c),
    nextPriceLabel: c.nextPrice ? `od ${ymd(c.nextPrice.from).d}.${ymd(c.nextPrice.from).m}: ${money(c.nextPrice.grosze)}` : null,
    full,
    state: win === 'open' && full ? 'full' : win,
    extras: extrasFor(extras, c.categoryId),
  }
}

const kmLabel = (km) => (km == null ? '' : `${String(km).replace('.', ',')} km`)

/** At least two profile points and some difference in height. */
function hasElevation(profile) {
  if (!Array.isArray(profile) || profile.length < 2) return false
  const eles = profile.map((p) => p[1])
  return Math.max(...eles) > Math.min(...eles)
}

/** One tab per GPX file, in competition order. */
function courses(competitions) {
  const groups = new Map()
  for (const c of competitions) {
    if (!c.course) continue
    const id = c.course.gpxUrl ?? c.course.gpxPath
    if (!groups.has(id)) groups.set(id, { course: c.course, label: c.distanceLabel || kmLabel(c.course.km), names: [] })
    groups.get(id).names.push(c.name)
  }
  return [...groups.values()].map(({ course, label, names }, i) => {
    const elevation = hasElevation(course.profile)
    return {
      key: `trasa-${i + 1}`,
      label,
      competitionNames: names.join(' · ').toLocaleUpperCase('pl'),
      km: course.km ?? null,
      // A GPX without <ele>, or with one constant value, says nothing about
      // the climb: no profile and no up/down rather than a flat line and „0 m”.
      hasElevation: elevation,
      upM: elevation ? (course.upM ?? null) : null,
      downM: elevation ? (course.downM ?? null) : null,
      points: course.points ?? null,
      profile: elevation ? course.profile : [],
      gpxUrl: course.gpxUrl ?? null,
    }
  })
}

const osmUrl = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
// Google's documented cross-platform Maps URL: opens the app on a phone, the site elsewhere.
const googleMapsUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
/** The map links for a pin, or nulls when there is none. */
const mapLinks = (lat, lng) => (lat != null && lng != null
  ? { mapUrl: osmUrl(lat, lng), googleMapsUrl: googleMapsUrl(lat, lng) }
  : { mapUrl: null, googleMapsUrl: null })
const join = (...parts) => parts.filter(Boolean).join(', ') || null

/** Where the start is: the event place and pin set in Podstawy. */
function startPlace(raw) {
  const t = raw.town ?? {}
  const label = join(t.label, t.placeDetails)
  if (!label && t.lat == null) return null
  return { label, ...mapLinks(t.lat, t.lng) }
}

// „2.12.2026, 23:59”: the last Warsaw minute of registration. closesAt is
// exclusive (the Warsaw midnight after the last day), so the label reads the
// minute before it.
const warsawParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function closesLabel(closesAt) {
  if (!closesAt) return null
  const p = Object.fromEntries(warsawParts.formatToParts(new Date(Date.parse(closesAt) - 60 * 1000)).map((x) => [x.type, x.value]))
  return `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`
}

/** Where the race office is: its own address and pin, or the event's. */
function officePlace(raw) {
  const o = raw.office ?? {}
  const t = raw.town ?? {}
  const [label, lat, lng] = o.sameAsEvent
    ? [join(t.label, t.placeDetails), t.lat, t.lng]
    : [o.address || null, o.lat, o.lng]
  if (!label && lat == null) return null
  return { label, ...mapLinks(lat, lng) }
}

// A team competition's taken and capacity count teams (D5-28), so people and teams are never
// added into one number: registered / confirmed / free are the individual competitions', and
// `teams` holds the team competitions' own (`only`: the event has no individual competition), or
// null when the event has none.
function stats(competitions, daysLeft) {
  const sum = (rows, f) => rows.reduce((n, c) => n + f(c), 0)
  const people = competitions.filter((c) => c.kind !== 'team')
  const teams = competitions.filter((c) => c.kind === 'team')
  const free = (c) => Math.max(0, c.capacity - c.taken)
  return {
    registered: sum(people, (c) => c.taken),
    confirmed: sum(people, (c) => c.confirmed),
    free: sum(people, free),
    teams: teams.length ? { registered: sum(teams, (c) => c.taken), free: sum(teams, free), only: !people.length } : null,
    daysLeft,
  }
}

/**
 * RA1's „Zapisani” and „Wolne” as lines of { count, unit }. With no team competition each is one
 * bare number, as it always was. Otherwise people and teams are separate lines with their units,
 * and the people line is left out when the event has only team competitions.
 */
export function statParts(s) {
  if (!s.teams) return { registered: [{ count: s.registered, unit: null }], free: [{ count: s.free, unit: null }] }
  const people = (n, unit) => (s.teams.only ? [] : [{ count: n, unit }])
  return {
    registered: [
      ...people(s.registered, pluralPl(s.registered, 'osoba', 'osoby', 'osób')),
      { count: s.teams.registered, unit: pluralPl(s.teams.registered, 'drużyna', 'drużyny', 'drużyn') },
    ],
    free: [...people(s.free, pluralPl(s.free, 'miejsce', 'miejsca', 'miejsc')), { count: s.teams.free, unit: 'dla drużyn' }],
  }
}

/**
 * @param {object} raw a registration_raw snapshot with file URLs
 * @param {Date} now
 */
export function eventPageModel(raw, now = new Date()) {
  const competitions = raw.competitions ?? []
  const win = windowState(raw, now)
  const date = raw.eventDate ? ymd(raw.eventDate) : null
  return {
    title: raw.name,
    dateLabel: date ? `${date.d}.${date.m}.${date.y} · ${WEEKDAYS[weekday(raw.eventDate)]}` : null,
    placeLabel: raw.town?.label ?? null,
    eventPlace: join(raw.town?.label, raw.town?.placeDetails),
    organizerName: raw.club?.name ?? null,
    // registration_settings.contact_email: the address the organizer gave for runners.
    contactEmail: raw.contactEmail ?? null,
    officePlace: officePlace(raw),
    startPlace: startPlace(raw),
    // The office set „at the event place”: the page says so instead of repeating the address.
    officeAtStart: !!raw.office?.sameAsEvent,
    registrationState: win,
    closesLabel: closesLabel(raw.closesAt),
    charityGoal: raw.isCharity ? (raw.charityGoal ?? null) : null,
    // A link only to an http(s) address, whatever the stored value says.
    charityUrl: raw.isCharity && /^https?:\/\//i.test(raw.charityUrl ?? '') ? raw.charityUrl : null,
    // „N% dochodu trafia na: …” in the charity panel; only what the organizer stated.
    charityPercent: raw.isCharity && Number.isInteger(raw.charityPercent) ? raw.charityPercent : null,
    // Plain text: the page keeps its line breaks and never renders it as HTML.
    description: raw.description || null,
    // „Więcej informacji” under the description: http(s) only, like charityUrl.
    websiteUrl: /^https?:\/\//i.test(raw.websiteUrl ?? '') ? raw.websiteUrl : null,
    stats: stats(competitions, win === 'closed' ? null : daysLeftLabel(raw, now)),
    office: (raw.office?.hours ?? []).map((h) => {
      const { d, m } = ymd(h.date)
      return { label: `${WEEKDAYS_SHORT[weekday(h.date)]} ${d}.${m}`, hours: `${hm(h.from)}–${hm(h.to)}`, ...(h.note ? { note: h.note } : {}) }
    }),
    competitions: competitions.map((c) => competitionRow(c, win, raw.extras)),
    // „Lista startowa” (/events/:slug/lista, the /api/startlist snapshot).
    showStartList: competitions.length > 0,
    regulaminUrl: raw.regulamin?.url ?? null,
    courses: courses(competitions),
  }
}

// ---------------------------------------------------------------- preview

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k)

/** Copies the listed snake_case keys of `from` that are present onto camelCase keys. */
function pick(target, from, map) {
  for (const [snake, camel] of Object.entries(map)) if (has(from, snake)) target[camel] = from[snake]
  return target
}

function courseFrom(upload) {
  if (!upload) return undefined
  const { km = null, upM = null, downM = null, points = null, profile = [] } = upload.meta ?? {}
  return { km, upM, downM, points, profile, gpxPath: upload.path }
}

// The staged tiers (snake_case, in the grid's order) as registration_raw would read them at
// `now`: the current tier is the first ending today or later (Warsaw) or open-ended; the next
// one starts the day after it ends. A tier's price is keyed by its id or new:<index>.
function stagedTierPrices(tiers, prices, now) {
  const today = warsawToday(now)
  const keyed = tiers.map((t, i) => ({ endsOn: t.ends_on ?? null, key: t.id ?? `new:${i}` }))
  const i = keyed.findIndex((t) => t.endsOn == null || t.endsOn >= today)
  if (i < 0) return { priceGrosze: null, nextPrice: null }
  const cur = keyed[i]
  const next = cur.endsOn != null ? keyed[i + 1] : null
  const [y, m, d] = (cur.endsOn ?? '').split('-').map(Number)
  return {
    priceGrosze: prices?.[cur.key] ?? null,
    nextPrice: next && prices?.[next.key] != null
      ? { grosze: prices[next.key], from: new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) }
      : null,
  }
}

function mergeCompetitions(raw, value, uploads, now) {
  const pricingMode = value.pricing_mode ?? raw.pricingMode
  const live = new Map(raw.competitions.map((c) => [c.categoryId, c]))
  // The raw leaves hidden competitions out, so an item with an id the raw lacks
  // and no `hidden` flag is one that stays hidden.
  const shown = (i) => (has(i, 'hidden') ? !i.hidden : !i.category_id || live.has(i.category_id))
  const competitions = (value.items ?? []).filter(shown).map((i) => {
    const base = live.get(i.category_id) ?? {
      categoryId: null, kind: 'individual', teamMin: null, teamMax: null, legOrderEnabled: false,
      taken: 0, confirmed: 0, priceGrosze: null, nextPrice: null,
      ageGroups: [], kidsGroups: [], course: null,
    }
    const c = pick({ ...base }, i, {
      name: 'name', kind: 'kind', team_min: 'teamMin', team_max: 'teamMax',
      discipline: 'discipline', distance_label: 'distanceLabel', start_time: 'startTime',
      capacity: 'capacity', min_age: 'minAge', max_age: 'maxAge', is_kids: 'isKids', timed: 'timed',
    })
    if (has(i, 'gpx_upload_id')) c.course = i.gpx_upload_id ? (courseFrom(uploads[i.gpx_upload_id]) ?? base.course) : null
    if (pricingMode === 'free') { c.priceGrosze = 0; c.nextPrice = null } else if (pricingMode === 'tiered' && value.tiers && i.prices) {
      Object.assign(c, stagedTierPrices(value.tiers, i.prices, now))
    } else if (i.price != null) { c.priceGrosze = i.price; c.nextPrice = null }
    return c
  })
  return { ...raw, pricingMode, competitions }
}

function groupsBy(rows, toItem) {
  const out = new Map()
  for (const g of rows ?? []) {
    if (!out.has(g.category_id)) out.set(g.category_id, [])
    out.get(g.category_id).push(toItem(g))
  }
  return out
}

// Staged extras as registration_raw shows them: what is left is the staged stock less what the
// live variant already sold (`pending.sold`, by variant id).
function mergeExtras(raw, items, uploads, sold) {
  const live = new Map((raw.extras ?? []).map((x) => [x.id, x]))
  return items.map((x) => ({
    id: x.id ?? null,
    name: x.name,
    description: x.description ?? null,
    imagePath: x.image_upload_id ? (uploads[x.image_upload_id]?.path ?? live.get(x.id)?.imagePath ?? null) : null,
    price: x.price,
    orderUntil: x.order_until,
    categoryIds: x.category_ids ?? [],
    variants: (x.variants ?? []).map((v) => ({ id: v.id ?? null, label: v.label, left: Math.max(0, v.stock - (v.id ? (sold[v.id] ?? 0) : 0)) })),
  }))
}

/**
 * The organizer preview: staged sections (registration_pending_changes.payload,
 * each the validated snake_case value save-registration-section stages) over
 * the live raw. `pending.uploads` maps the upload ids the payload names to
 * { path, meta }; `pending.sold` maps a live extra variant's id to its sales.
 * Returns a new raw; the input is not changed.
 * `payload.competitions.items[].hidden` (published events only): true hides that
 * competition from the preview, false or absent shows it. Staged tiers are read
 * at `now`, as registration_raw reads the live ones.
 */
export function mergePending(raw, pending, now = new Date()) {
  const payload = pending?.payload
  if (!payload) return raw
  const uploads = pending.uploads ?? {}
  let out = { ...raw, competitions: raw.competitions ?? [] }

  if (payload.basics) {
    const b = payload.basics
    pick(out, b, {
      name: 'name', slug: 'slug', event_date: 'eventDate', first_start_time: 'firstStartTime', opens_at: 'opensAt', closes_at: 'closesAt',
      is_charity: 'isCharity', charity_goal: 'charityGoal', charity_url: 'charityUrl', charity_percent: 'charityPercent', donations_enabled: 'donationsEnabled',
      description: 'description', website_url: 'websiteUrl',
      contact_email: 'contactEmail',
    })
    out.town = pick({ ...raw.town }, b, { town_label: 'label', town_area: 'area', place_details: 'placeDetails', lat: 'lat', lng: 'lng' })
    const reg = pick({ ...raw.regulamin }, b, { regulamin_kind: 'kind' })
    if (has(b, 'regulamin_url') && reg.kind === 'link') reg.url = b.regulamin_url
    if (has(b, 'regulamin_upload_id')) reg.path = uploads[b.regulamin_upload_id]?.path ?? (b.regulamin_upload_id ? reg.path : null)
    if (reg.kind === 'pdf') reg.url = null
    else reg.path = null
    out.regulamin = reg
    if (has(b, 'poster_upload_id')) out.posterPath = uploads[b.poster_upload_id]?.path ?? (b.poster_upload_id ? raw.posterPath : null)
  }
  if (payload.office) {
    out.office = pick({ ...raw.office }, payload.office, {
      office_same_as_event: 'sameAsEvent', office_address: 'address', office_notes: 'notes',
      office_lat: 'lat', office_lng: 'lng', hours: 'hours',
    })
  }
  if (payload.competitions) out = mergeCompetitions(out, payload.competitions, uploads, now)
  if (payload.extras) out.extras = mergeExtras(raw, payload.extras.items ?? [], uploads, pending.sold ?? {})
  if (payload.categories) {
    const v = payload.categories
    pick(out, v, { age_reckoning: 'ageReckoning' })
    const age = has(v, 'age_groups') && groupsBy(v.age_groups, (g) => ({ gender: g.gender, label: g.label, minAge: g.min_age, maxAge: g.max_age }))
    const kids = has(v, 'kids_groups') && groupsBy(v.kids_groups, (g) => ({
      label: g.label, birthYearFrom: g.birth_year_from, birthYearTo: g.birth_year_to, gender: g.gender, distanceLabel: g.distance_label,
    }))
    out.competitions = out.competitions.map((c) => ({
      ...c,
      ...(age ? { ageGroups: age.get(c.categoryId) ?? [] } : {}),
      ...(kids ? { kidsGroups: kids.get(c.categoryId) ?? [] } : {}),
    }))
  }
  if (payload.timing) {
    out.timing = pick({ ...raw.timing }, payload.timing, {
      timing_mode: 'mode', timing_company: 'company', results_url: 'resultsUrl', live_results_url: 'liveResultsUrl',
    })
  }
  if (payload.form) {
    pick(out, payload.form, { form_fields: 'formFields' })
    const legs = payload.form.leg_order
    if (legs) {
      out.competitions = out.competitions.map((c) => (c.categoryId in legs ? { ...c, legOrderEnabled: legs[c.categoryId] } : c))
    }
    if (has(payload.form, 'consents')) {
      out.consents = [
        ...(raw.consents ?? []).filter((k) => k.kind !== 'custom'),
        ...payload.form.consents.map((k) => ({ id: k.id ?? null, kind: 'custom', text: k.text, minorsOnly: k.minorsOnly === true })),
      ]
    }
  }
  return out
}
