// What submit-contribution accepts, checked before anything is written. The function used to
// insert whatever the payload held: any length of text, any URL scheme (a `javascript:` link in
// registration_url reaches an admin's screen and, once approved, a public page), a price of 1e308,
// a distances array of a million entries. Plain ESM, no Deno APIs (node tests import it).
//
// null and undefined mean "not given" for every optional field: the public forms send null for an
// empty input.

export const LIMITS = {
  short: 200, // names, titles, a reported field name, a category
  text: 5000, // free text: messages, notes, old and suggested values
  url: 500,
  distances: 30,
  distanceLabel: 50,
  eventTypes: 10,
  price: 100000,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const given = (v) => v !== undefined && v !== null

function str(v, max, { required = false } = {}) {
  if (!given(v)) return required ? 'required' : null
  if (typeof v !== 'string') return 'must be a string'
  if (required && !v.trim()) return 'required'
  if (v.length > max) return `too long (max ${max})`
  return null
}

/** http(s) or empty only: a link an admin, and later the public, may click. */
export function isHttpUrl(v) {
  if (typeof v !== 'string' || v.length > LIMITS.url) return false
  let u
  try { u = new URL(v) } catch { return false }
  return u.protocol === 'http:' || u.protocol === 'https:'
}

function url(v) {
  if (!given(v) || v === '') return null
  if (typeof v !== 'string') return 'must be a string'
  if (v.length > LIMITS.url) return `too long (max ${LIMITS.url})`
  return isHttpUrl(v) ? null : 'must be an http(s) URL'
}

function num(v, min, max) {
  if (!given(v)) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a finite number'
  if (v < min || v > max) return `out of range (${min}..${max})`
  return null
}

function date(v, { required = false } = {}) {
  if (!given(v) || v === '') return required ? 'required' : null
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) return 'must be YYYY-MM-DD'
  return null
}

function distances(v) {
  if (!given(v)) return null
  if (!Array.isArray(v)) return 'must be an array'
  if (v.length > LIMITS.distances) return `too many (max ${LIMITS.distances})`
  for (const d of v) {
    if (typeof d === 'number') {
      if (!Number.isFinite(d) || d < 0 || d > 100000) return 'invalid distance'
    } else if (typeof d === 'string') {
      if (d.length > LIMITS.distanceLabel) return 'invalid distance'
    } else {
      return 'invalid distance'
    }
  }
  return null
}

function stringArray(v, maxItems, maxLen) {
  if (!given(v)) return null
  if (!Array.isArray(v)) return 'must be an array'
  if (v.length > maxItems) return `too many (max ${maxItems})`
  return v.every((s) => typeof s === 'string' && s.length <= maxLen) ? null : 'invalid entry'
}

const RULES = {
  event_report: {
    field: (v) => str(v, LIMITS.short),
    old_value: (v) => str(v, LIMITS.text),
    suggested_value: (v) => str(v, LIMITS.text),
    source_url: url,
    note: (v) => str(v, LIMITS.text),
  },
  event_submission: {
    name: (v) => str(v, LIMITS.short, { required: true }),
    date: (v) => date(v, { required: true }),
    location: (v) => str(v, LIMITS.short),
    voivodeship: (v) => str(v, LIMITS.short),
    registration_url: url,
    website: url,
    regulamin_url: url,
    distances,
    event_type: (v) => stringArray(v, LIMITS.eventTypes, LIMITS.short),
    price_from: (v) => num(v, 0, LIMITS.price),
    price_to: (v) => num(v, 0, LIMITS.price),
    registration_deadline: (v) => date(v),
    lat: (v) => num(v, -90, 90),
    lng: (v) => num(v, -180, 180),
  },
  general_feedback: {
    category: (v) => str(v, LIMITS.short),
    message: (v) => str(v, LIMITS.text, { required: true }),
  },
}

/**
 * @param {{ type: string, reference_id?: unknown, payload?: unknown }} body
 * @returns {string|null} the first problem found, as "<field>: <reason>", or null when valid
 */
export function validateContribution({ type, reference_id, payload }) {
  const rules = RULES[type]
  if (!rules) return 'type: invalid'
  if (given(reference_id) && (typeof reference_id !== 'string' || !UUID_RE.test(reference_id))) {
    return 'reference_id: must be a UUID'
  }
  // A report is about one calendar event: calendar_event_id is NOT NULL.
  if (type === 'event_report' && !given(reference_id)) return 'reference_id: required'
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    return 'payload: must be an object'
  }
  const p = payload ?? {}
  for (const [field, check] of Object.entries(rules)) {
    const problem = check(p[field])
    if (problem) return `${field}: ${problem}`
  }
  return null
}
