// The /kalendarz page's data and the filters the database used to apply.
//
// The calendar used to query Supabase on every filter change and every page, from every
// visitor. It now reads one static file, /kalendarz/events.json, written at build time by
// scripts/generate-event-pages.js from the committed manifest, and filters it here. A race
// shows up after the manifest is refreshed and deployed, which is when it is approved.

export const CALENDAR_DATA_PATH = '/kalendarz/events.json'

/** Fields the calendar list, map and grid read. The build script writes only these. */
export const CALENDAR_FIELDS = [
  'id', 'name', 'date', 'location', 'voivodeship', 'lat', 'lng', 'distances', 'event_type',
  'price_from', 'price_to', 'registration_deadline', 'status', 'leszyrun_event_id', 'created_at',
]

let cached = null

/** Loads the calendar once per page load; a failed load is retried on the next call. */
export function loadCalendarEvents(fetchImpl = fetch) {
  if (!cached) {
    cached = fetchImpl(CALENDAR_DATA_PATH)
      .then(r => {
        if (!r.ok) throw new Error(`calendar data: HTTP ${r.status}`)
        return r.json()
      })
      .catch(err => {
        cached = null
        throw err
      })
  }
  return cached
}

const lower = s => (s || '').toLocaleLowerCase('pl')

/**
 * The filters Supabase applied before: date range, "Dodane", search, type, region, club.
 * `startDate`/`endDate` are YYYY-MM-DD, `addedSince` an ISO timestamp, all optional.
 * Search matches a substring of the name or the location, case-insensitively, like ILIKE.
 * Returns a new array sorted by date.
 */
export function filterCalendarEvents(events, { startDate, endDate, addedSince, search, types = [], voivodeships = [], ids = null } = {}) {
  const needle = lower(search).trim()
  const idSet = ids ? new Set(ids) : null
  const addedMs = addedSince ? Date.parse(addedSince) : null
  return events
    .filter(e => {
      if (e.status !== 'active' && e.status !== 'cancelled') return false
      const date = String(e.date).slice(0, 10)
      if (startDate && date < startDate) return false
      if (endDate && date > endDate) return false
      if (addedMs != null && !(e.created_at && Date.parse(e.created_at) >= addedMs)) return false
      if (needle && !lower(e.name).includes(needle) && !lower(e.location).includes(needle)) return false
      if (types.length && !types.some(t => (e.event_type || []).includes(t))) return false
      if (voivodeships.length && !voivodeships.includes(e.voivodeship)) return false
      if (idSet && !idSet.has(e.id)) return false
      return true
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
}
