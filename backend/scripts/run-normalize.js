import { createClient } from '@supabase/supabase-js'

// Usage: cd backend && node --env-file=../.env scripts/run-normalize.js
// Normalizes scraper_all before publishing to calendar_events:
// - Voivodeship → Title-Case (e.g. "dolnośląskie" → "Dolnośląskie", "Śląsk" → "Śląskie")
// - Event types: merges event_type + event_types into a single normalized event_types array

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

// --- Main ---

async function main() {
  console.log(dryRun ? '=== DRY RUN (use --apply to write to DB) ===' : '=== APPLYING ===')
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('id, name, voivodeship, event_type, event_types')
      .range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Processing ${allRows.length} rows`)
  let voivFixed = 0, typesFixed = 0, typeCleared = 0, unchanged = 0, voivDropped = 0

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

    if (Object.keys(updates).length > 0) {
      if (!dryRun) {
        const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
        if (error) {
          console.error(`\n  ERR ${row.id}: ${error.message}`)
          continue
        }
      }
      const changes = []
      if (updates.voivodeship) { voivFixed++; changes.push(`voiv: ${row.voivodeship} → ${updates.voivodeship}`) }
      if ('event_types' in updates) { typesFixed++; changes.push(`types: [${(row.event_types || []).join(', ')}] → [${(updates.event_types || []).join(', ')}]`) }
      if ('event_type' in updates && !('event_types' in updates)) { typeCleared++; changes.push(`event_type cleared: ${row.event_type}`) }
      console.log(`  ${dryRun ? 'WOULD' : '✓'} ${row.name} → ${changes.join(' | ')}`)
    } else {
      unchanged++
    }
  }

  console.log(`\n\nDone:`)
  console.log(`  Voivodeship fixed: ${voivFixed}${voivDropped ? ` (${voivDropped} unknown, skipped)` : ''}`)
  console.log(`  Event types normalized: ${typesFixed}`)
  console.log(`  Raw event_type cleared: ${typeCleared}`)
  console.log(`  Unchanged: ${unchanged}`)
}

main().catch(console.error)
