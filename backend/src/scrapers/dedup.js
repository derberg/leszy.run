import { supabase } from '../lib/supabaseClient.js'

// Source priority — lower number = higher priority (wins on conflict)
const SOURCE_PRIORITY = {
  dostartu: 1,
  biegiwpolsce: 2,
  timekeeper: 3,
  elektronicznezapisy: 4,
  datasport: 7,
  maratonypolskie: 9,
  pomiarczasuatelier: 8,
  supersport: 5,
  zmierzymyczas: 6,
}

// Fields only set by LLM enricher or manual edits — scrapers never touch these
const PROTECTED_FIELDS = new Set([
  'id', 'created_at', 'status', 'enriched_at', 'leszyrun_event_id',
  'registration_deadline', 'price_from', 'price_to',
])

// Fields that come from scraper_all (normalized) and can be written to calendar_events
const SCRAPER_FIELDS = [
  'name', 'date', 'registration_deadline', 'location', 'voivodeship',
  'lat', 'lng', 'event_type', 'distances',
  'registration_url', 'regulamin_url', 'website',
  'price_from', 'price_to',
  'is_kids',
]

// Polish adjective/noun suffixes for rough stemming
const SUFFIXES = ['owski', 'ewski', 'owska', 'ewska', 'ński', 'ńska', 'ski', 'ska', 'owy', 'owa', 'owe', 'iego', 'ego', 'ach', 'iem']

function stemPL(word) {
  for (const s of SUFFIXES) {
    if (word.endsWith(s) && word.length - s.length >= 3) {
      return word.slice(0, -s.length)
    }
  }
  return word
}

const STOP_WORDS = new Set(['bieg', 'run', 'maraton', 'marathon', 'biegi', 'edycja', 'zawody', 'impreza'])

function tokenize(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9ąćęłńóśźż ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
    .filter(t => !/^\d+$/.test(t) && !/^[ivxlcdm]+$/.test(t))
    .map(stemPL)
}

function jaccardSimilarity(a, b) {
  const tokA = tokenize(a)
  const tokB = tokenize(b)
  const setA = new Set(tokA)
  const setB = new Set(tokB)
  const intersection = [...setA].filter(t => setB.has(t)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

function distinctTokenSimilarity(a, b) {
  const tokA = tokenize(a).filter(t => !STOP_WORDS.has(t))
  const tokB = tokenize(b).filter(t => !STOP_WORDS.has(t))
  const setA = new Set(tokA)
  const setB = new Set(tokB)
  if (setA.size === 0 && setB.size === 0) return 1
  const intersection = [...setA].filter(t => setB.has(t)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

function extractCity(location) {
  if (!location) return null
  const city = location
    .replace(/\s*(ul\.|al\.|os\.|pl\.)\s.*/i, '')
    .split(/[,\-–]/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-ząćęłńóśźż ]/g, '')
    .trim()
  return city.length >= 2 ? city : null
}

function citiesMatch(locA, locB) {
  const cityA = extractCity(locA)
  const cityB = extractCity(locB)
  if (!cityA || !cityB) return false
  return cityA.includes(cityB) || cityB.includes(cityA)
}

function isEmpty(val) {
  return val === null || val === undefined ||
    (Array.isArray(val) && val.length === 0) ||
    val === ''
}

/**
 * Find a matching calendar_events row for the given normalized event.
 * Checks source_links jsonb first, then fuzzy match.
 */
async function findExistingMatch(event) {
  if (!supabase) return null

  // 1. Check if any source_link from this event exists in calendar_events
  const sourceLinks = event.source_links || []
  for (const link of sourceLinks) {
    if (!link.source_id) continue

    const { data } = await supabase
      .from('calendar_events')
      .select('*')
      .contains('source_links', JSON.stringify([{ source: link.source, source_id: link.source_id }]))

    if (data && data.length > 0) return data[0]
  }

  // Fallback: legacy source/source_id columns
  if (event.source_id) {
    const { data: legacy } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('source', event.source)
      .eq('source_id', event.source_id)
      .single()

    if (legacy) return legacy
  }

  // 2. Cross-source fuzzy match: same date + name similarity
  const { data: candidates } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('date', event.date)

  if (!candidates) return null

  for (const c of candidates) {
    const jaccard = jaccardSimilarity(c.name, event.name)
    const locMatch = citiesMatch(c.location, event.location)

    if (jaccard > 0.6) return c
    if (locMatch && jaccard > 0.35) return c
    if (locMatch && distinctTokenSimilarity(c.name, event.name) > 0.4) return c
    if (locMatch && tokenize(c.name).length <= 3 && tokenize(event.name).length <= 3 && jaccard > 0.25) return c
  }

  return null
}

/**
 * Upsert a normalized event (from scraper_all) into calendar_events.
 * Since scraper_all already has the best-priority data merged, this always
 * overwrites scraper fields and preserves LLM/manual fields.
 */
async function upsertEvent(event) {
  if (!supabase) return { action: 'skipped', id: null, error: { message: 'Supabase not configured' } }

  const existing = await findExistingMatch(event)
  const now = new Date().toISOString()

  if (existing) {
    if (existing.status === 'rejected') {
      return { action: 'skipped', id: existing.id, error: null }
    }

    // scraper_all already resolved priority — overwrite all scraper fields
    const updates = {}
    for (const key of SCRAPER_FIELDS) {
      const newVal = event[key]
      if (newVal === null || newVal === undefined) continue
      if (Array.isArray(newVal) && newVal.length === 0) continue
      updates[key] = newVal
    }

    updates.source = event.source
    updates.source_id = event.source_id
    updates.source_url = event.source_url
    updates.source_links = event.source_links || []
    updates.last_verified_at = now
    updates.updated_at = now

    const { error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', existing.id)

    return { action: 'updated', id: existing.id, error }
  } else {
    const row = {}
    // Only copy non-protected fields
    for (const [key, value] of Object.entries(event)) {
      if (!PROTECTED_FIELDS.has(key)) {
        row[key] = value
      }
    }
    row.source_links = event.source_links || []
    row.last_verified_at = now
    row.scraped_at = now

    const { data, error } = await supabase
      .from('calendar_events')
      .insert(row)
      .select('id')
      .single()

    return { action: 'created', id: data?.id, error }
  }
}

export { findExistingMatch, upsertEvent, jaccardSimilarity, citiesMatch, tokenize, SOURCE_PRIORITY }
