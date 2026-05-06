// Shared registry of AI-fillable scraper_all fields used by run-enrich-search.js
// and run-enrich-from-regulamin.js. Adding a new column? Add ONE row here and
// both enrichers automatically include it in their prompt + merge logic.
//
// Each entry:
//   isEmpty(row)       — true when the column should be enriched
//   promptHint         — short description handed to the LLM
//   validate(v, row)   — return validated value or null/undefined to drop

export const VALID_EVENT_TYPES = [
  'uliczny', 'przełajowy', 'górski', 'nocny', 'ocr',
  'nordic walking', 'ultra', 'charytatywny',
]

export const VALID_VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-pomorskie', 'Lubelskie', 'Lubuskie', 'Łódzkie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const isHttpUrl = v => typeof v === 'string' && /^https?:\/\//.test(v.trim())
const trimmedString = v => (typeof v === 'string' && v.trim()) ? v.trim() : null

export const AI_FILLABLE = {
  website: {
    isEmpty: r => !r.website,
    promptHint: 'official event website URL (organizer domain or Facebook fallback)',
    validate: v => isHttpUrl(v) ? v.trim() : null,
  },
  registration_url: {
    isEmpty: r => !r.registration_url,
    promptHint: 'sign-up / registration URL',
    validate: v => isHttpUrl(v) ? v.trim() : null,
  },
  regulamin_url: {
    isEmpty: r => !r.regulamin_url,
    promptHint: 'regulamin (rules) PDF URL',
    validate: v => isHttpUrl(v) ? v.trim() : null,
  },
  distances: {
    isEmpty: r => !r.distances || !String(r.distances).trim(),
    promptHint: 'race distances comma-separated string (e.g. "5 km, 10 km, 21.1 km" — półmaraton=21.1, maraton=42.2)',
    validate: trimmedString,
  },
  event_types: {
    isEmpty: r => !r.event_types || r.event_types.length === 0,
    promptHint: `array of one or more types from: ${VALID_EVENT_TYPES.join(', ')}. Use ["nie-bieg"] for non-running events`,
    validate: v => {
      if (!Array.isArray(v)) return null
      const filtered = v.filter(t => VALID_EVENT_TYPES.includes(t) || t === 'nie-bieg')
      return filtered.length > 0 ? filtered : null
    },
  },
  location: {
    isEmpty: r => !r.location,
    promptHint: 'city/town/village where the event starts (single placename, e.g. "Warszawa", "Lisewo Malborskie")',
    validate: trimmedString,
  },
  voivodeship: {
    isEmpty: r => !r.voivodeship,
    promptHint: `Polish voivodeship, exactly one of: ${VALID_VOIVODESHIPS.join(', ')}`,
    validate: v => VALID_VOIVODESHIPS.includes(v) ? v : null,
  },
  price_from: {
    isEmpty: r => r.price_from == null,
    promptHint: 'lowest registration fee in PLN (integer złote, not groszy)',
    validate: v => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
    },
  },
  price_to: {
    isEmpty: r => r.price_to == null,
    promptHint: 'highest registration fee in PLN (integer złote)',
    validate: v => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
    },
  },
  registration_deadline: {
    isEmpty: r => !r.registration_deadline,
    promptHint: 'registration cutoff as YYYY-MM-DD (must be within 1 year of event date)',
    validate: (v, row) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
      if (row?.date) {
        const ev = new Date(row.date)
        const dl = new Date(v)
        if (Number.isNaN(ev.getTime()) || Number.isNaN(dl.getTime())) return null
        if (Math.abs((ev - dl) / 86400000) > 365) return null
      }
      return v
    },
  },
  is_kids: {
    isEmpty: r => r.is_kids === null || r.is_kids === undefined,
    promptHint: 'true ONLY if a dedicated kids race / "biegi dzieci" exists; null otherwise',
    validate: v => v === true ? true : null,
  },
}

// Helpers used by both enrichers.

export function pickFillable(keys) {
  const out = {}
  for (const k of keys) {
    if (AI_FILLABLE[k]) out[k] = AI_FILLABLE[k]
  }
  return out
}

export function fieldsNeedingFill(row, registry = AI_FILLABLE) {
  return Object.entries(registry)
    .filter(([_, def]) => def.isEmpty(row))
    .map(([k]) => k)
}

export function applyRegistryUpdates(row, llmResult, fields, registry = AI_FILLABLE) {
  const updates = {}
  for (const field of fields) {
    const def = registry[field]
    if (!def) continue
    const raw = llmResult?.[field]
    if (raw === undefined || raw === null) continue
    const validated = def.validate(raw, row)
    if (validated === null || validated === undefined) continue
    if (Array.isArray(validated) && validated.length === 0) continue
    updates[field] = validated
  }
  // Cross-field price sanity
  if (updates.price_from != null && updates.price_to != null && updates.price_from > updates.price_to) {
    delete updates.price_from
    delete updates.price_to
  }
  return updates
}
