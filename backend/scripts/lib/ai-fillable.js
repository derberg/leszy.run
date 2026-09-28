// Shared registry of AI-fillable scraper_all fields used by run-enrich-search.js
// and run-enrich-from-regulamin.js. Adding a new column? Add ONE row here and
// both enrichers automatically include it in their prompt + merge logic.
//
// Each entry:
//   isEmpty(row)       — true when the column should be enriched
//   promptHint         — short description handed to the LLM
//   validate(v, row)   — return validated value or null/undefined to drop

import { hasFreeEvidence } from '../../src/lib/extractionEvidence.js'

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
  // NOTE: `website` is intentionally NOT enriched here. Searching for an
  // organizer website is low-yield effort — the regulamin PDF and registration
  // page are the source-of-truth documents and carry far more (distances,
  // prices, deadline, kids categories, types). Focus the LLM budget there.
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
    // Always include for rows not yet search-enriched — LLM verifies/corrects even when set.
    isEmpty: r => !r.event_types || r.event_types.length === 0 || !r.enriched_search_at,
    promptHint: r => {
      const current = r?.event_types?.length ? r.event_types.join(', ') : null
      const base = `array of one or more types from: ${VALID_EVENT_TYPES.join(', ')}`
      if (current) {
        return `${base}. CURRENT: [${current}] — verify against found content and correct if wrong. Use ["nie-bieg"] for non-running events`
      }
      return `${base}. Use ["nie-bieg"] for non-running events`
    },
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
    promptHint: 'lowest registration fee in PLN (integer złote, not groszy). A document that says entry costs nothing ("bez opłaty startowej", "udział jest bezpłatny", "wpisowe: 0 zł") HAS stated the fee — answer 0, not null',
    validate: v => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
    },
  },
  price_to: {
    isEmpty: r => r.price_to == null,
    promptHint: 'highest registration fee in PLN (integer złote). A document that says entry costs nothing ("bez opłaty startowej", "udział jest bezpłatny", "wpisowe: 0 zł") HAS stated the fee — answer 0, not null',
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
    // Re-check when false — regulamin often confirms kids categories the scraper missed.
    isEmpty: r => r.is_kids !== true,
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

/**
 * Supply the price a "no entry fee" document states without writing a number.
 *
 * herkules:4279 "Bieg Niepodległości" published with no price: its regulamin
 * says "BEZ OPŁATY STARTOWEJ !!!!" and the model, asked for a fee "or null if
 * not stated", found no digits and answered null. Free is a value, so the
 * prompt hint alone is not enough — fill it deterministically too.
 *
 * hasFreeEvidence() is borrowed only as the wording test; it is a REJECT-only
 * gate (see extractionEvidence.js) and matching it is a necessary condition
 * here, never a sufficient one. It fires on a per-category waiver too: a paid
 * regulamin reading "50 zł, dzieci do lat 7 bez opłaty startowej" matches. So
 * does hasFeeEvidence(), which the word "opłat" puts in every free regulamin —
 * it cannot tell the two apart, and a "any złotówka amount means paid" test
 * would misfire on the prize money a free race still lists. What does tell
 * them apart is a fee already known: if the row carries a non-zero price, or
 * the model read one out of this same document, the document charges somebody
 * and we are looking at a waiver, not a free race. Then we fill nothing.
 *
 * Only ever fills an empty field; a fee the model did read always wins.
 *
 * @param {object} llmResult  the LLM's parsed JSON (mutated in place)
 * @param {string} text       the document the extraction came from
 * @param {object} row        the row being enriched, for prices already stored
 */
export function fillFreeEntryPrices(llmResult, text, row = {}) {
  if (!llmResult || typeof llmResult !== 'object') return
  if (!hasFreeEvidence(text)) return
  const charges = v => v != null && Number.isFinite(Number(v)) && Number(v) !== 0
  for (const f of ['price_from', 'price_to']) {
    if (charges(llmResult[f]) || charges(row?.[f])) return
  }
  for (const f of ['price_from', 'price_to']) {
    if (llmResult[f] === undefined || llmResult[f] === null) llmResult[f] = 0
  }
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
  // Cross-field price sanity, against the pair the row ENDS UP with. Only an
  // empty column is ever fillable, so half a price pair arrives here alone:
  // price_to=0 onto a stored price_from=50 compared nothing against nothing
  // and wrote the inverted pair run-data-audit.js flags as `inverted`.
  const finalFrom = updates.price_from != null ? updates.price_from : row?.price_from
  const finalTo = updates.price_to != null ? updates.price_to : row?.price_to
  if (finalFrom != null && finalTo != null && finalFrom > finalTo) {
    delete updates.price_from
    delete updates.price_to
  }
  return updates
}
