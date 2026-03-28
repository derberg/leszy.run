import { supabase } from '../lib/supabaseClient.js'

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

// Noise words that don't help distinguish events
const STOP_WORDS = new Set(['bieg', 'run', 'maraton', 'marathon', 'biegi', 'edycja', 'zawody', 'impreza'])

function tokenize(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9ąćęłńóśźż ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
    // Strip edition numbers, ordinals, Roman numerals
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

// Jaccard on meaningful tokens only (excluding generic running words)
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
  // Take the first meaningful part (before comma, dash, or "ul./al./os.")
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
  // One contains the other (handles "Wrocław" vs "Wrocław Stare Miasto")
  return cityA.includes(cityB) || cityB.includes(cityA)
}

async function findExistingMatch(event) {
  if (!supabase) return null

  // 1. Exact source match
  if (event.source_id) {
    const { data } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('source', event.source)
      .eq('source_id', event.source_id)
      .single()

    if (data) return data
  }

  // 2. Cross-source fuzzy match: same date, then score by name tokens + location
  const { data: candidates } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('date', event.date)

  if (!candidates) return null

  for (const c of candidates) {
    const jaccard = jaccardSimilarity(c.name, event.name)
    const locMatch = citiesMatch(c.location, event.location)

    // High name similarity alone — confident match
    if (jaccard > 0.6) return c

    // Same city + moderate name overlap — likely same event from different source
    if (locMatch && jaccard > 0.35) return c

    // Same city + same date + similar distinctive tokens (ignoring generic words like "bieg", "maraton")
    if (locMatch && distinctTokenSimilarity(c.name, event.name) > 0.4) return c

    // Same date + same city + both names too short/generic for token comparison
    // e.g. "Bieg Nocny" vs "Nocny Bieg" in the same city on the same day
    if (locMatch && tokenize(c.name).length <= 3 && tokenize(event.name).length <= 3 && jaccard > 0.25) return c
  }

  return null
}

async function upsertEvent(event) {
  if (!supabase) return { action: 'skipped', id: null, error: { message: 'Supabase not configured' } }

  const existing = await findExistingMatch(event)

  if (existing) {
    // Never resurrect rejected events
    if (existing.status === 'rejected') {
      return { action: 'skipped', id: existing.id, error: null }
    }

    // Only fill in fields that are missing on the existing event — never overwrite
    const updates = {}
    const protectedKeys = ['id', 'created_at', 'status']
    for (const [key, value] of Object.entries(event)) {
      if (protectedKeys.includes(key)) continue
      if (value === null || value === undefined) continue
      if (Array.isArray(value) && value.length === 0) continue

      const existingVal = existing[key]
      const isEmpty = existingVal === null || existingVal === undefined ||
        (Array.isArray(existingVal) && existingVal.length === 0) ||
        existingVal === ''
      if (isEmpty) {
        updates[key] = value
      }
    }
    updates.last_verified_at = new Date().toISOString()
    if (Object.keys(updates).length === 1) {
      // Only last_verified_at — nothing to fill in
      updates.updated_at = new Date().toISOString()
    }

    const { error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', existing.id)

    return { action: 'updated', id: existing.id, error }
  } else {
    const { data, error } = await supabase
      .from('calendar_events')
      .insert(event)
      .select('id')
      .single()

    return { action: 'created', id: data?.id, error }
  }
}

export { findExistingMatch, upsertEvent, jaccardSimilarity, citiesMatch, tokenize }
