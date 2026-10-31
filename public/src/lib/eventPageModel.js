// The public registration event page (RA1, RA1b) as display values, from the
// raw snapshot that registration_raw / registration_public return.
//
// eventPageModel(raw, now): raw must already have its file URLs
// (withFileUrls in eventFiles.js). mergePending(raw, pending): the organizer
// preview's staged changes laid over the raw, before withFileUrls. Pure: the
// page, the preview and the unit tests call the same functions.

// The Warsaw calendar date (YYYY-MM-DD) of an instant; same rule as
// warsawToday() in _shared/registration/dates.js, kept here so this module has
// no imports.
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

function competitionRow(c, win) {
  const age = ageLabel(c.minAge, c.maxAge)
  const byAge = c.isKids && c.kidsGroups?.some((g) => g.distanceLabel) ? 'dystans wg wieku' : null
  const full = c.taken >= c.capacity
  return {
    categoryId: c.categoryId,
    name: c.name,
    startLabel: [c.startTime ? `start ${hm(c.startTime)}` : null, age, byAge].filter(Boolean).join(' · '),
    ageLabel: age,
    priceLabel: c.priceGrosze == null ? null : c.priceGrosze === 0 ? 'Bezpłatne' : money(c.priceGrosze),
    nextPriceLabel: c.nextPrice ? `od ${ymd(c.nextPrice.from).d}.${ymd(c.nextPrice.from).m}: ${money(c.nextPrice.grosze)}` : null,
    full,
    state: win === 'open' && full ? 'full' : win,
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
const join = (...parts) => parts.filter(Boolean).join(', ') || null

/** Where the start is: the event place and pin set in Podstawy. */
function startPlace(raw) {
  const t = raw.town ?? {}
  const label = join(t.label, t.placeDetails)
  if (!label && t.lat == null) return null
  return { label, mapUrl: t.lat != null && t.lng != null ? osmUrl(t.lat, t.lng) : null }
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
  return { label, mapUrl: lat != null && lng != null ? osmUrl(lat, lng) : null }
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
    stats: {
      registered: competitions.reduce((n, c) => n + c.taken, 0),
      confirmed: competitions.reduce((n, c) => n + c.confirmed, 0),
      free: competitions.reduce((n, c) => n + Math.max(0, c.capacity - c.taken), 0),
      daysLeft: win === 'closed' ? null : daysLeftLabel(raw, now),
    },
    office: (raw.office?.hours ?? []).map((h) => {
      const { d, m } = ymd(h.date)
      return { label: `${WEEKDAYS_SHORT[weekday(h.date)]} ${d}.${m}`, hours: `${hm(h.from)}–${hm(h.to)}` }
    }),
    competitions: competitions.map((c) => competitionRow(c, win)),
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

function mergeCompetitions(raw, value, uploads) {
  const pricingMode = value.pricing_mode ?? raw.pricingMode
  const live = new Map(raw.competitions.map((c) => [c.categoryId, c]))
  // The raw leaves hidden competitions out, so an item with an id the raw lacks
  // and no `hidden` flag is one that stays hidden.
  const shown = (i) => (has(i, 'hidden') ? !i.hidden : !i.category_id || live.has(i.category_id))
  const competitions = (value.items ?? []).filter(shown).map((i) => {
    const base = live.get(i.category_id) ?? {
      categoryId: null, kind: 'individual', taken: 0, confirmed: 0, priceGrosze: null, nextPrice: null,
      ageGroups: [], kidsGroups: [], course: null,
    }
    const c = pick({ ...base }, i, {
      name: 'name', discipline: 'discipline', distance_label: 'distanceLabel', start_time: 'startTime',
      capacity: 'capacity', min_age: 'minAge', max_age: 'maxAge', is_kids: 'isKids', timed: 'timed',
    })
    if (has(i, 'gpx_upload_id')) c.course = i.gpx_upload_id ? (courseFrom(uploads[i.gpx_upload_id]) ?? base.course) : null
    if (pricingMode === 'free') { c.priceGrosze = 0; c.nextPrice = null } else if (i.price != null) { c.priceGrosze = i.price; c.nextPrice = null }
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

/**
 * The organizer preview: staged sections (registration_pending_changes.payload,
 * each the validated snake_case value save-registration-section stages) over
 * the live raw. `pending.uploads` maps the upload ids the payload names to
 * { path, meta }. Returns a new raw; the input is not changed.
 * `payload.competitions.items[].hidden` (published events only): true hides that
 * competition from the preview, false or absent shows it.
 */
export function mergePending(raw, pending) {
  const payload = pending?.payload
  if (!payload) return raw
  const uploads = pending.uploads ?? {}
  let out = { ...raw, competitions: raw.competitions ?? [] }

  if (payload.basics) {
    const b = payload.basics
    pick(out, b, {
      name: 'name', slug: 'slug', event_date: 'eventDate', first_start_time: 'firstStartTime', opens_at: 'opensAt', closes_at: 'closesAt',
      is_charity: 'isCharity', charity_goal: 'charityGoal', donations_enabled: 'donationsEnabled',
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
  if (payload.competitions) out = mergeCompetitions(out, payload.competitions, uploads)
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
    if (has(payload.form, 'consents')) {
      out.consents = [
        ...(raw.consents ?? []).filter((k) => k.kind !== 'custom'),
        ...payload.form.consents.map((k) => ({ id: k.id ?? null, kind: 'custom', text: k.text })),
      ]
    }
  }
  return out
}
