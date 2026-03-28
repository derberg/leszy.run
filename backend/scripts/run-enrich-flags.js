import { createClient } from '@supabase/supabase-js'

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-flags.js
// Enriches scraper_all:
// - Adds 'charytatywny' to event_types if name contains charity keywords
// - Sets is_kids=true if any distance is ≤ 1 km

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const CHARITY_KEYWORDS = ['charytatywn', 'charity', 'dla schroniska', 'dla hospicjum', 'pomagani', 'fundacj', 'wośp', 'wosp']

function isCharity(name) {
  const lower = (name || '').toLowerCase()
  return CHARITY_KEYWORDS.some(kw => lower.includes(kw))
}

function hasKidsDistance(distances) {
  if (!distances) return false
  // distances is a text field, e.g. "5 km, 10 km, 0.5 km, 200m"
  const str = distances.toLowerCase()

  // Check meter distances: 200m, 500m, 800m, 1000m
  const meterMatches = str.matchAll(/(\d+)\s*m\b/g)
  for (const m of meterMatches) {
    const meters = parseInt(m[1])
    if (meters > 0 && meters <= 1000) return true
  }

  // Check km distances ≤ 1: 0.5 km, 1 km, 0.3 km
  const kmMatches = str.matchAll(/(\d+[.,]?\d*)\s*km/g)
  for (const m of kmMatches) {
    const km = parseFloat(m[1].replace(',', '.'))
    if (km > 0 && km <= 1) return true
  }

  return false
}

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
  let charityAdded = 0, kidsSet = 0, unchanged = 0

  for (const row of allRows) {
    const updates = {}

    // Charity check
    if (isCharity(row.name)) {
      const types = row.event_types || []
      if (!types.includes('charytatywny')) {
        updates.event_types = [...types, 'charytatywny']
      }
    }

    // Kids distance check
    if (!row.is_kids && hasKidsDistance(row.distances)) {
      updates.is_kids = true
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
      if (error) {
        console.error(`  ERR ${row.name}: ${error.message}`)
      } else {
        if (updates.event_types) { charityAdded++; process.stdout.write('C') }
        if (updates.is_kids) { kidsSet++; process.stdout.write('K') }
      }
    } else {
      unchanged++
    }
  }

  console.log(`\n\nDone: ${charityAdded} charity tagged, ${kidsSet} kids flagged, ${unchanged} unchanged`)
}

main().catch(console.error)
