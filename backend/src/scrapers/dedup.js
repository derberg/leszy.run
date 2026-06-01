import { supabase } from '../lib/supabaseClient.js'

// Source priority — lower number = higher priority (wins on conflict)
const SOURCE_PRIORITY = {
  dostartu: 1,
  biegiwpolsce: 2,
  timekeeper: 3,
  lumisport: 3,
  protiming24: 3,
  elektronicznezapisy: 4,
  datasport: 7,
  maratonypolskie: 9,
  pomiarczasuatelier: 8,
  b4sport: 8,
  supersport: 5,
  zmierzymyczas: 6,
  raatiming: 8,
  superczas: 10,
  bgtimesport: 3,
  rajsportactive: 3,
  sporttime: 8,
  wbtiming: 8,
  czasomierzyk: 8,
  kepasport: 3,
  inessport: 3,
  aleczas: 8,
  maratonczykpomiarczasu: 8,
  timing4u: 8,
  zapisyonline: 4,
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

/**
 * Extract semantic "distinguishing tags" from an event — categories of
 * meaning where a difference between two events SHOULD prevent merging
 * even when their tokenized names overlap. Three categories:
 *   - audience: kids vs adult
 *   - distance: Maraton vs Półmaraton vs Ćwierćmaraton
 *   - style:    trail / nordic walking / ocr / ultra
 *
 * Used by both `findScraperAllMatch` (raw → scraper_all merge) and
 * `run-dedup.js` (within-scraper_all dedup) so identical semantic-distinct
 * pairs aren't re-collapsed downstream.
 */
function distinguishingTags(event) {
  const tags = new Set()
  const n = (event.name || '').toLowerCase()

  // Audience — kids events should never collapse with adult events.
  // Guard is name-based only: is_kids=true in scraper_* can come from
  // sub-category detection on mixed events where the umbrella name has no
  // kids keywords — using it here would create false conflicts between
  // scrapers that see the kids sub-races and scrapers that don't.
  if (/dzieci|świetlik|małych\s+żeglar|małych\s+biega|junior|młodzież|biegi\s+dla\s+dzieci/i.test(n)) {
    tags.add('audience:kids')
  }
  // CE rows fold is_kids into event_type as 'dzieci' — pick that up so the
  // guard applies on both sides of the publish-time fuzzy compare. Note that
  // mixed family events (e.g. CE event_type=['uliczny','dzieci']) tag as
  // audience:kids here, which matches a same-event SA row whose is_kids flag
  // is also true. Both sides see "kids race exists" → no conflict, allowed
  // to merge. SA rows with is_kids=true that are kids-only (e.g. Świetlików,
  // Małych Żeglarzy) still get rejected against CE rows lacking 'dzieci'.
  const eventTypes = []
  if (Array.isArray(event.event_types)) eventTypes.push(...event.event_types)
  if (Array.isArray(event.event_type)) eventTypes.push(...event.event_type)
  if (eventTypes.includes('dzieci')) tags.add('audience:kids')

  // Distance class — most-specific match first (Polish-letter-aware so
  // "maraton" inside "półmaraton"/"ćwierćmaraton" doesn't double-tag)
  if (/półmaraton|pulmaraton|pólmaraton/i.test(n)) tags.add('distance:half')
  else if (/ćwierćmaraton|cwiercmaraton|ćwierć\s*maraton|cwierc\s*maraton/i.test(n)) tags.add('distance:quarter')
  else if (/(?:^|[^\p{L}])maraton(?:[^\p{L}]|$)/iu.test(n)) tags.add('distance:full')

  // Style — collected from event_types/event_type AND from name regexes
  const types = []
  if (Array.isArray(event.event_types)) types.push(...event.event_types)
  if (Array.isArray(event.event_type)) types.push(...event.event_type)
  else if (typeof event.event_type === 'string') types.push(event.event_type)
  for (const t of types) {
    if (t === 'trail') tags.add('style:trail')
    else if (t === 'nordic walking') tags.add('style:nw')
    else if (t === 'ocr') tags.add('style:ocr')
    else if (t === 'ultra') tags.add('style:ultra')
  }
  if (/nordic\s*walking|\bnw\b/i.test(n)) tags.add('style:nw')
  if (/\bocr\b/i.test(n)) tags.add('style:ocr')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(n)) tags.add('style:ultra')
  if (/cross(owy|owa|owe)\b|\btrail\b/i.test(n)) tags.add('style:trail')

  return tags
}

/**
 * Returns true if events A and B have conflicting tags in any category.
 * Conflict = within a category, A and B have different tag sets (different
 * presence, or different specific tags). Identical sets in all categories
 * (including both empty) → no conflict, merge can proceed.
 */
function hasDistinguishingConflict(tagsA, tagsB) {
  const categories = new Set()
  for (const t of tagsA) categories.add(t.split(':')[0])
  for (const t of tagsB) categories.add(t.split(':')[0])
  for (const cat of categories) {
    const inA = [...tagsA].filter(t => t.startsWith(cat + ':'))
    const inB = [...tagsB].filter(t => t.startsWith(cat + ':'))
    // One side has no info for this category (e.g. unenriched scraper row with
    // event_types=null vs LLM-enriched row with trail/nw). Absence ≠ denial —
    // skip rather than flagging a spurious conflict.
    if (inA.length === 0 || inB.length === 0) continue
    if (inA.length !== inB.length) return true
    if (!inA.every(t => inB.includes(t))) return true
  }
  return false
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

export { findExistingMatch, upsertEvent, jaccardSimilarity, citiesMatch, tokenize, SOURCE_PRIORITY, distinguishingTags, hasDistinguishingConflict }
