// The facts a /kalendarz/:slug race page shows, computed once for both renderers:
// EventPage/EventInfoGrid in the browser and scripts/generate-event-pages.js at build
// time. Until 2026-11 the build wrote only <head> tags and an empty #root, so a crawler
// that did not run JavaScript saw no name, date, distance or price on any race page.
// Keep everything here free of JSX and browser APIs: the build script imports it.

export const TYPE_LABELS = {
  trail: 'trail',
  nocny: 'nocny',
  ocr: 'OCR',
  nordic: 'nordic walking',
  ultra: 'ultramaraton',
  charytatywny: 'charytatywny',
  uliczny: 'uliczny',
}

// Tailwind classes live in this .js file so the class scanner sees them for both renderers.
const baseTag = 'font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border uppercase'

export function typeTagClass(type) {
  if (type === 'nocny') return `${baseTag} border-[rgba(148,130,220,0.3)] text-[#9482dc]`
  if (type === 'charytatywny') return `${baseTag} border-[rgba(45,90,39,0.5)] text-[#5baa52]`
  return `${baseTag} border-apex-cyan/30 text-apex-cyan`
}

export const distTagClass = `${baseTag} border-[rgba(168,194,58,0.3)] text-apex-yellow-dim`

// A distance whose course holds a valid PZLA atest: the same chip, brighter, with the mark.
export const atestDistTagClass = `${baseTag} border-apex-yellow/60 bg-apex-yellow/10 text-apex-yellow`

// "21.1 km" → 21.1, "Półmaraton" → 21.0975. The same rule as the backend's distanceKm
// (backend/src/lib/atestMatch.js), which decided the atest; null for "6h" and the like.
function distanceKm(d) {
  if (typeof d !== 'string') return null
  const s = d.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
  if (/\d\s*h(\b|$)/.test(s)) return null
  if (/polmaraton|half/.test(s)) return 21.0975
  if (/maraton|marathon/.test(s)) return 42.195
  const m = s.match(/\d+(?:[.,]\d+)?/)
  if (!m) return null
  const n = parseFloat(m[0].replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  if (/\d\s*m\b|metr/.test(s) && !/km|kilometr/.test(s)) return n / 1000
  if (n === 21) return 21.0975
  if (n === 42) return 42.195
  return n
}

/**
 * The race's distances whose course is in the PZLA register of certified courses
 * (event.atest, written by backend/scripts/run-atest.js), as the race's own strings.
 * @returns {Set<string>}
 */
export function atestDistances(event) {
  const certified = (Array.isArray(event?.atest) ? event.atest : []).map(a => Number(a.km)).filter(Number.isFinite)
  const out = new Set()
  if (!certified.length) return out
  for (const d of event.distances || []) {
    const km = distanceKm(d)
    if (km != null && certified.some(c => Math.abs(c - km) <= 0.05)) out.add(d)
  }
  return out
}

const TZ = 'Europe/Warsaw'

/** "11 listopada 2026" */
export function formatDateLong(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ })
}

/** "środa, 11 listopada 2026" */
export function formatDateWithWeekday(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ })
}

function formatDateShort(dateStr) {
  return new Date(dateStr).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ })
}

export function priceText(event) {
  const from = event.price_from
  const to = event.price_to
  if (from == null && to == null) return null
  if (from === 0 && (to == null || to === 0)) return 'Za darmo'
  if (from === 0 && to != null && to > 0) return `od 0 zł (za darmo) do ${to} zł`
  if (from != null && to != null) return `od ${from} zł do ${to} zł`
  if (from != null) return from === 0 ? 'Za darmo' : `od ${from} zł`
  return `do ${to} zł`
}

function deadlineState(event, now) {
  if (!event.registration_deadline) return null
  const closed = new Date(event.registration_deadline + 'T23:59:59') < now
  return { closed, formatted: formatDateShort(event.registration_deadline) }
}

/** Event types worth a tag ("bieg" says nothing on a running calendar). */
export function eventTypes(event) {
  return (event.event_type || []).filter(t => t !== 'bieg')
}

/**
 * The info grid's cells, in display order, only those with data.
 * @returns {{ label: string, value: string, accent?: boolean, closed?: boolean }[]}
 */
export function infoCells(event, now = new Date()) {
  const cells = []
  if (event.date) cells.push({ label: 'Data', value: formatDateLong(event.date) })
  if (event.location || event.voivodeship) {
    cells.push({ label: 'Lokalizacja', value: [event.location, event.voivodeship].filter(Boolean).join(', ') })
  }
  if (event.distances?.length) cells.push({ label: 'Dystanse', value: event.distances.join(' / ') })
  const atest = [...atestDistances(event)]
  if (atest.length) cells.push({ label: 'Atest PZLA', value: atest.join(' / ') })
  const price = priceText(event)
  if (price) cells.push({ label: 'Cena', value: price, accent: true })
  const deadline = deadlineState(event, now)
  if (deadline) {
    cells.push({
      label: 'Termin zapisów',
      value: deadline.closed ? `Zapisy zamknięte (${deadline.formatted})` : `do ${deadline.formatted}`,
      accent: true,
      closed: deadline.closed,
    })
  }
  return cells
}
