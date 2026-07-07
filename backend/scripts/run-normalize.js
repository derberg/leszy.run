import { createClient } from '@supabase/supabase-js'
import { writeRunLog } from './lib/run-log.js'

// Usage: cd backend && node --env-file=../.env scripts/run-normalize.js
// Normalizes scraper_all before publishing to calendar_events:
// - Voivodeship → Title-Case (e.g. "dolnośląskie" → "Dolnośląskie", "Śląsk" → "Śląskie")
// - Event types: merges event_type + event_types into a single normalized event_types array
// - Distances → canonical unit + spacing (see normalizeDistances below)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const dryRun = !process.argv.includes('--apply')

// --- Voivodeship normalization ---

const CANONICAL_VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

// Build lookup: lowercase → canonical
const VOIVODESHIP_MAP = Object.fromEntries(
  CANONICAL_VOIVODESHIPS.map(v => [v.toLowerCase(), v])
)
// Fix common non-standard values
VOIVODESHIP_MAP['śląsk'] = 'Śląskie'
// Source-side typos (timesport listing misspelling for Radom-area events)
VOIVODESHIP_MAP['mazaowieckie'] = 'Mazowieckie'

function normalizeVoivodeship(raw) {
  if (!raw) return null
  return VOIVODESHIP_MAP[raw.toLowerCase().trim()] || null
}

// --- Event type normalization ---

// Maps raw values (lowercased) to normalized types
const EVENT_TYPE_MAP = {
  // trail — all off-road: mountain, forest, cross-country
  'trail':            'trail',
  'górski':           'trail',
  'przełajowy':       'trail',
  'przełaj/cross':    'trail',
  'przełaj':          'trail',
  'cross':            'trail',

  // uliczny — road/urban
  'uliczny':          'uliczny',

  // nordic walking
  'nw':               'nordic walking',
  'nordic':           'nordic walking',
  'nordic-walking':   'nordic walking',
  'nordic walking':   'nordic walking',

  // OCR — obstacle course
  'ocr':              'ocr',
  'z przeszkodami':   'ocr',

  // charity
  'charytatywny':     'charytatywny',

  // night
  'nocny':            'nocny',

  // ultra
  'ultra':            'ultra',

  // orienteering
  'na orientację':    'na orientację',

  // kids
  'dzieci':           'dzieci',

  // drop — generic/useless
  'bieg':             null,
  'inny':             null,
}

function normalizeEventTypes(eventType, eventTypes) {
  const raw = []

  // event_type: string from dostartu
  if (eventType) raw.push(eventType)

  // event_types: array from biegiwpolsce / enrich-flags
  if (eventTypes && Array.isArray(eventTypes)) raw.push(...eventTypes)

  const normalized = new Set()
  for (const t of raw) {
    const mapped = EVENT_TYPE_MAP[t.toLowerCase().trim()]
    if (mapped) normalized.add(mapped)
    // null / undefined = drop (bieg, inny, unknown)
  }

  return normalized.size > 0 ? [...normalized].sort() : null
}

// --- Distance normalization ---
//
// scraper_all.distances is a single comma-separated string, e.g. "1 km, 500m, 0.2 km".
// Canonical format (one agreed setup so the DB is consistent):
//   - distance < 1000 m  → metres, e.g. "200 m"
//   - distance >= 1000 m → kilometres, e.g. "5 km", "21.1 km"
//   - always a SPACE between number and unit
//   - dot for decimals
// Time-based ("6h"), word-based ("Maraton", "Półmaraton") and bare unitless numbers
// are left untouched (can't be safely converted). Duplicates are collapsed, order kept.

function formatMeters(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return null
  if (meters < 1000) return `${Math.round(meters)} m`
  const km = parseFloat((meters / 1000).toFixed(3)) // strip float noise, max 3 decimals
  return `${km} km`
}

function normalizeDistanceToken(token) {
  const t = token.trim()
  if (!t) return null
  const lower = t.toLowerCase()

  // time-based: "6h", "12 h" → "6h"
  const time = lower.match(/^(\d{1,3})\s*h$/)
  if (time) return `${time[1]}h`

  // number + km / kilometr
  let m = lower.match(/^(\d+(?:[.,]\d+)?)\s*(?:km|kilometr\w*)$/)
  if (m) return formatMeters(parseFloat(m[1].replace(',', '.')) * 1000) || t

  // number + m / metr (but NOT km — handled above)
  m = lower.match(/^(\d+(?:[.,]\d+)?)\s*(?:m|metr\w*)$/)
  if (m) return formatMeters(parseFloat(m[1].replace(',', '.'))) || t

  // words ("maraton"), bare numbers, anything else → leave untouched
  return t
}

function normalizeDistances(raw) {
  if (!raw || typeof raw !== 'string') return raw
  // The data uses commas as BOTH decimal separators ("42,2 km") and token
  // separators ("5 km, 10 km"), plus ";" and "+" as alternative token separators.
  // Convert decimal-commas to dots first so the comma is unambiguously a separator,
  // then split on , ; +. Output always re-joins with ", ".
  const dotted = raw.replace(/(\d),(\d)/g, '$1.$2')
  const out = []
  const seen = new Set()
  for (const tok of dotted.split(/[,;+]/)) {
    const norm = normalizeDistanceToken(tok)
    if (!norm) continue
    const key = norm.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(norm)
  }
  return out.join(', ')
}

// --- Main ---

async function main() {
  const startedAt = new Date().toISOString()
  console.log(dryRun ? '=== DRY RUN (use --apply to write to DB) ===' : '=== APPLYING ===')
  const errors = []
  const unknownVoiv = []
  const changes = []
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('id, name, voivodeship, event_type, event_types, distances')
      .range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Processing ${allRows.length} rows`)
  let voivFixed = 0, typesFixed = 0, typeCleared = 0, unchanged = 0, voivDropped = 0, distsFixed = 0

  for (const row of allRows) {
    const updates = {}

    // Voivodeship
    if (row.voivodeship) {
      const norm = normalizeVoivodeship(row.voivodeship)
      if (norm && norm !== row.voivodeship) {
        updates.voivodeship = norm
      } else if (!norm) {
        // Unknown voivodeship value — log but don't touch
        console.warn(`\n  UNKNOWN voivodeship: "${row.voivodeship}" (id: ${row.id})`)
        voivDropped++
        unknownVoiv.push({ id: row.id, name: row.name, value: row.voivodeship })
      }
    }

    // Event types — merge and normalize
    const normTypes = normalizeEventTypes(row.event_type, row.event_types)
    const currentTypes = row.event_types || []
    const typesChanged = JSON.stringify(normTypes?.sort() || null) !== JSON.stringify(currentTypes.length ? [...currentTypes].sort() : null)
    if (typesChanged) {
      updates.event_types = normTypes
    }

    // Clear raw event_type after merging into normalized event_types
    if (row.event_type && ('event_types' in updates || normTypes)) {
      updates.event_type = null
    }

    // Distances — canonical unit + spacing
    if (row.distances && row.distances.trim()) {
      const normDist = normalizeDistances(row.distances)
      if (normDist && normDist !== row.distances) {
        updates.distances = normDist
      }
    }

    if (Object.keys(updates).length > 0) {
      if (!dryRun) {
        const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
        if (error) {
          console.error(`\n  ERR ${row.id}: ${error.message}`)
          errors.push({ id: row.id, name: row.name, message: error.message })
          continue
        }
      }
      const rowChanges = []
      if (updates.voivodeship) { voivFixed++; rowChanges.push(`voiv: ${row.voivodeship} → ${updates.voivodeship}`) }
      if ('event_types' in updates) { typesFixed++; rowChanges.push(`types: [${(row.event_types || []).join(', ')}] → [${(updates.event_types || []).join(', ')}]`) }
      if ('event_type' in updates && !('event_types' in updates)) { typeCleared++; rowChanges.push(`event_type cleared: ${row.event_type}`) }
      if ('distances' in updates) { distsFixed++; rowChanges.push(`distances: ${row.distances} → ${updates.distances}`) }
      console.log(`  ${dryRun ? 'WOULD' : '✓'} ${row.name} → ${rowChanges.join(' | ')}`)
      changes.push({ id: row.id, name: row.name, updates })
    } else {
      unchanged++
    }
  }

  console.log(`\n\nDone:`)
  console.log(`  Voivodeship fixed: ${voivFixed}${voivDropped ? ` (${voivDropped} unknown, skipped)` : ''}`)
  console.log(`  Event types normalized: ${typesFixed}`)
  console.log(`  Raw event_type cleared: ${typeCleared}`)
  console.log(`  Distances normalized: ${distsFixed}`)
  console.log(`  Unchanged: ${unchanged}`)

  if (!dryRun) {
    const logFile = await writeRunLog('normalize', {
      script: 'normalize',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      processed: allRows.length,
      voiv_fixed: voivFixed,
      types_normalized: typesFixed,
      type_cleared: typeCleared,
      dists_normalized: distsFixed,
      voiv_unknown: voivDropped,
      unchanged,
      unknown_voivodeships: unknownVoiv,
      errors,
      changes,
    })
    console.log(`Run log: ${logFile}`)
  }
}

main().catch(console.error)
