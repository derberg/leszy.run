import { createClient } from '@supabase/supabase-js'

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-flags.js
// Enriches scraper_all:
// - Classifies event type from name keywords (uses normalized types: górski, nocny, etc.)
// - Adds 'charytatywny' to event_types if name contains charity keywords
// - Sets is_kids=true if any distance is ≤ 1 km
// - Extracts distances from event name when missing (półmaraton, maraton, dycha, N km, etc.)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// --- Event type classification from name keywords ---
// Output uses normalized type names (matching run-normalize.js output)

const TYPE_KEYWORDS = {
  'górski': [
    'trail', 'przełaj', 'przelaj', 'przełajow', 'przelajow', 'cross country',
    'cross', 'kros', 'kross', 'crossow',
    'terenow', 'górsk', 'gorsk', 'górami',
    'leśn', 'lesn', 'puszcz', 'borów', 'borow', 'borem',
    'szlak', 'szlakiem', 'dolin', 'wąwoz', 'wawoz', 'grzbiet',
    'szczyt', 'przelecz', 'przełęcz', 'skałk', 'skalk',
    'bieszczad', 'beskid', 'karkonosk', 'tatrzańsk', 'tatrzansk',
    'sudecka', 'sudecki', 'izersk', 'pieniński', 'pieninski',
    'ślężańsk', 'slezansk', 'świętokrzys', 'swietokrzys',
    'jurajsk', 'jura ',
    'bezdroż', 'bezdroz',
  ],
  'nocny': ['nocny', 'nocna', 'nocn', 'night', 'noc ', 'w noc', 'wieczorn'],
  'ocr': ['ocr', 'runmageddon', 'spartan', 'barbarian', 'survival', 'extremaln', 'przeszkod', 'mud', 'tough', 'ninja'],
  'nordic walking': ['nordic', 'marsz', 'nw)', 'z kijami', 'z kijkami'],
  'ultra': ['ultra', 'ultramaraton'],
  'charytatywny': ['charytatywn', 'charity', 'dla schroniska', 'dla hospicjum', 'pomagani', 'fundacj', 'wośp', 'wosp'],
  'uliczny': ['uliczn', 'dycha', 'dychy', 'dyszka', 'dyszki'],
}

function classifyTypeFromName(name) {
  const lower = (name || '').toLowerCase()
  const types = []
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      types.push(type)
    }
  }
  return types
}

// --- Distance extraction from name ---

function extractDistancesFromName(name) {
  if (!name) return null
  const lower = name.toLowerCase()
  const distances = []
  const seen = new Set()

  function add(val) {
    if (!seen.has(val)) { distances.push(val); seen.add(val) }
  }

  // Named distances first
  if (lower.includes('półmaraton') || lower.includes('polmaraton') || lower.includes('half')) {
    add('21.1 km')
  }
  // "maraton" but not "półmaraton", "ultramaraton"
  if (/\bmaraton\b/.test(lower) && !lower.includes('pół') && !lower.includes('pol') && !lower.includes('ultra') && !lower.includes('half')) {
    add('42.2 km')
  }

  // Explicit "N km" in name
  const kmMatches = lower.matchAll(/(\d+[.,]?\d*)\s*km/g)
  for (const m of kmMatches) {
    const km = parseFloat(m[1].replace(',', '.'))
    if (km > 0 && km < 500) add(`${Math.round(km * 10) / 10} km`)
  }

  // "dycha" / "dziesiątka" = 10 km, "piątka" = 5 km
  if (lower.includes('dycha') || lower.includes('dychy') || lower.includes('dziesiątka') || lower.includes('dziesiatka') || lower.includes('dyszka') || lower.includes('dyszki')) {
    add('10 km')
  }
  if (lower.includes('piątka') || lower.includes('piatka')) {
    add('5 km')
  }

  return distances.length > 0 ? distances.join(', ') : null
}

// --- Ultra detection from distances ---

function hasUltraDistance(distances) {
  if (!distances) return false
  const kmMatches = distances.matchAll(/(\d+[.,]?\d*)\s*km/g)
  for (const m of kmMatches) {
    const km = parseFloat(m[1].replace(',', '.'))
    if (km > 50) return true
  }
  return false
}

// --- Kids detection ---

const KIDS_KEYWORDS = ['dzieci', 'dzieciak', 'dziecięc', 'kids', 'junior', 'młodzież', 'młodzież', 'przedszkolak', 'kids cup', 'fun run']

function isKidsFromName(name) {
  const lower = (name || '').toLowerCase()
  return KIDS_KEYWORDS.some(kw => lower.includes(kw))
}

function hasKidsDistance(distances) {
  if (!distances) return false
  const str = distances.toLowerCase()

  const meterMatches = str.matchAll(/(\d+)\s*m\b/g)
  for (const m of meterMatches) {
    const meters = parseInt(m[1])
    if (meters > 0 && meters <= 1000) return true
  }

  const kmMatches = str.matchAll(/(\d+[.,]?\d*)\s*km/g)
  for (const m of kmMatches) {
    const km = parseFloat(m[1].replace(',', '.'))
    if (km > 0 && km <= 1) return true
  }

  return false
}

// --- Main ---

async function main() {
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('id, name, distances, event_type, event_types, is_kids')
      .range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Processing ${allRows.length} rows`)
  let typesAdded = 0, kidsSet = 0, distancesAdded = 0, unchanged = 0

  for (const row of allRows) {
    const updates = {}

    // Event type classification from name (only when no types exist yet)
    const currentTypes = row.event_types || []
    if (currentTypes.length === 0) {
      const detected = classifyTypeFromName(row.name)
      if (detected.length > 0) {
        updates.event_types = detected
      }
    } else {
      // Still check for charytatywny even if types exist
      const detected = classifyTypeFromName(row.name)
      if (detected.includes('charytatywny') && !currentTypes.includes('charytatywny')) {
        updates.event_types = [...currentTypes, 'charytatywny']
      }
    }

    // Ultra from distances (any distance > 50 km)
    const typesForUltra = updates.event_types || currentTypes
    if (!typesForUltra.includes('ultra') && hasUltraDistance(row.distances)) {
      updates.event_types = [...(updates.event_types || currentTypes), 'ultra']
    }

    // Kids detection — from distances (≤ 1 km) or name keywords
    if (!row.is_kids && (hasKidsDistance(row.distances) || isKidsFromName(row.name))) {
      updates.is_kids = true
    }

    // Extract distances from name when missing
    if (!row.distances || row.distances.trim() === '' || row.distances === '{}') {
      const extracted = extractDistancesFromName(row.name)
      if (extracted) {
        updates.distances = extracted
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
      if (error) {
        console.error(`  ERR ${row.name}: ${error.message}`)
      } else {
        if (updates.event_types) { typesAdded++; process.stdout.write('T') }
        if (updates.is_kids) { kidsSet++; process.stdout.write('K') }
        if (updates.distances) { distancesAdded++; process.stdout.write('D') }
      }
    } else {
      unchanged++
    }
  }

  console.log(`\n\nDone: ${typesAdded} types classified, ${kidsSet} kids flagged, ${distancesAdded} distances from name, ${unchanged} unchanged`)
}

main().catch(console.error)
