// The calendar reads the public pages used to send to Supabase, done on build-time data.
//
// `calendar_events` is no longer readable with the publishable key: every row of the race
// calendar, pending and rejected ones included, could be downloaded through PostgREST by
// anyone. The pages that listed races read /kalendarz/events.json instead (lib/calendarData.js,
// written by scripts/generate-event-pages.js), and one race's page reads the JSON embedded in
// its pre-rendered /kalendarz/<slug>/ file. Each function below is the query it replaced.

const day = (d) => String(d ?? '').slice(0, 10)
const byDate = (a, b) => day(a.date).localeCompare(day(b.date))

/** Today as YYYY-MM-DD in UTC, which is what the queries compared against. */
export const todayIso = (now = new Date()) => now.toISOString().slice(0, 10)

/**
 * "W okolicy tego weekendu": active races in the same voivodeship within 3 days of the
 * event, never in the past, the event itself left out, at most 5, soonest first.
 */
export function nearbyEvents(events, event, today = todayIso()) {
  if (!event?.voivodeship || !event?.date) return []
  const date = new Date(event.date)
  const from = new Date(date)
  from.setDate(from.getDate() - 3)
  const to = new Date(date)
  to.setDate(to.getDate() + 3)
  const fromStr = from.toISOString().slice(0, 10)
  const toStr = to.toISOString().slice(0, 10)
  const lower = fromStr > today ? fromStr : today
  return events
    .filter(e => e.status === 'active' && e.voivodeship === event.voivodeship && e.id !== event.id
      && day(e.date) >= lower && day(e.date) <= toStr)
    .sort(byDate)
    .slice(0, 5)
}

/** The landing page's calendar teaser: the next `limit` races from today. */
export function upcomingEvents(events, today = todayIso(), limit = 5) {
  return events
    .filter(e => (e.status === 'active' || e.status === 'cancelled') && day(e.date) >= today)
    .sort(byDate)
    .slice(0, limit)
}

/**
 * The calendar row of each leszy.run event, keyed by `leszyrun_event_id`: the "POLECAMY"
 * banner reads its type and distances from there, not from `events`.
 */
export function calendarRowsByLeszyrunId(events, ids) {
  const wanted = new Set(ids)
  const out = {}
  for (const e of events) if (e.leszyrun_event_id && wanted.has(e.leszyrun_event_id)) out[e.leszyrun_event_id] = e
  return out
}

// Mirrors parseDistanceToMeters from Kalendarz.jsx
export function parseDistanceToMeters(d) {
  if (!d || typeof d !== 'string') return NaN
  const s = d.toLowerCase().trim()
  if (/\d\s*h(\b|$)/.test(s)) return NaN
  if (s.includes('półmaraton') || s.includes('polmaraton')) return 21097
  if (s.includes('maraton')) return 42195
  const match = s.match(/[0-9]+([.,][0-9]+)?/)
  if (!match) return NaN
  const num = parseFloat(match[0].replace(',', '.'))
  if (isNaN(num)) return NaN
  if (/km|kilometr/.test(s)) return Math.round(num * 1000)
  if (/\d\s*m\b|metr/.test(s)) return Math.round(num)
  return Math.round(num * 1000)
}

const hasDistance = (e, min, max) => (e.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= min && m <= max })
const lowerPl = (s) => String(s ?? '').toLocaleLowerCase('pl')

/**
 * A /listy page's races: active, from today, registration still open (or no deadline), by
 * date, narrowed by the page's filters. Returns one page and the total the pager counts.
 * Half-marathons and marathons are selected by distance and shown unpaged, as before.
 */
export function landingEvents(events, filters, { today = todayIso(), page = 1, pageSize = 100, now = Date.now() } = {}) {
  const { special, typeDbVal, regionDb, year, month, city } = filters || {}
  let list = events
    .filter(e => e.status === 'active' && day(e.date) >= today
      && (e.registration_deadline == null || day(e.registration_deadline) >= today))
    .sort(byDate)
  if (regionDb) list = list.filter(e => e.voivodeship === regionDb)

  if (special === 'polmaratony' || special === 'maratony') {
    const result = special === 'polmaratony'
      ? list.filter(e => hasDistance(e, 19000, 23000))
      : list.filter(e => hasDistance(e, 41000, 44000))
    return { events: result, total: result.length }
  }
  if (special === 'dla-dzieci') {
    list = list.filter(e => (e.event_type || []).includes('dzieci'))
  } else if (special === 'darmowe') {
    list = list.filter(e => e.price_from === 0)
  } else if (special === 'ostatnia-szansa') {
    const deadline14 = new Date(now + 14 * 86400000).toISOString().slice(0, 10)
    list = list.filter(e => e.registration_deadline != null && day(e.registration_deadline) <= deadline14)
  } else {
    if (typeDbVal) list = list.filter(e => (e.event_type || []).includes(typeDbVal))
    if (city) list = list.filter(e => lowerPl(e.location).startsWith(lowerPl(city)))
    if (year && month) {
      const monthStr = String(month).padStart(2, '0')
      const lastDay = new Date(year, month, 0).getDate()
      const first = `${year}-${monthStr}-01`
      const last = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`
      list = list.filter(e => day(e.date) >= first && day(e.date) <= last)
    }
  }
  const from = (page - 1) * pageSize
  return { events: list.slice(from, from + pageSize), total: list.length }
}

const EVENT_DATA_RE = /<script id="event-data" type="application\/json">([\s\S]*?)<\/script>/

/** The race embedded in a pre-rendered /kalendarz/<slug>/ page, or null. */
export function parseEmbeddedEvent(html) {
  const m = EVENT_DATA_RE.exec(html || '')
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    return data && typeof data === 'object' && data.name && data.date ? data : null
  } catch {
    return null
  }
}

/**
 * One race by its slug, for SPA navigation to /kalendarz/<slug>: the same record a direct
 * hit reads from the page it lands on. A slug with no pre-rendered page gets the SPA shell,
 * which embeds no race, so it resolves to null (not found).
 */
export async function loadKalendarzEvent(slug, fetchImpl = fetch) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null
  const res = await fetchImpl(`/kalendarz/${slug}/index.html`)
  if (!res.ok) return null
  return parseEmbeddedEvent(await res.text())
}
