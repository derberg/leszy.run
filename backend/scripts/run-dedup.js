import { createClient } from '@supabase/supabase-js'
import { jaccardSimilarity, citiesMatch, tokenize, SOURCE_PRIORITY } from '../src/scrapers/dedup.js'

// Usage: cd backend && node --env-file=../.env scripts/run-dedup.js
// Run AFTER normalize (step 5.5), BEFORE publish (step 6).
//
// Finds duplicate rows within scraper_all (same date + similar name / same city)
// and merges the lower-priority row into the higher-priority one.
// The loser row is deleted; its source_link is added to the winner.
//
// Dry-run (default): node --env-file=../.env scripts/run-dedup.js
// Apply:             node --env-file=../.env scripts/run-dedup.js --apply

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const dryRun = !process.argv.includes('--apply')

function getPriority(source) {
  return SOURCE_PRIORITY[source] ?? 99
}

function isEmpty(val) {
  return val === null || val === undefined ||
    (Array.isArray(val) && val.length === 0) ||
    val === ''
}

const MERGE_FIELDS = [
  'name', 'end_date', 'location', 'voivodeship',
  'lat', 'lng', 'distances', 'event_type', 'event_types',
  'registration_url', 'regulamin_url', 'regulamin_urls', 'website',
  'is_kids',
]

function mergeSourceLinks(existingLinks, newLinks) {
  const links = Array.isArray(existingLinks) ? [...existingLinks] : []
  for (const nl of (Array.isArray(newLinks) ? newLinks : [])) {
    if (!links.some(l => l.source === nl.source && l.source_id === nl.source_id)) {
      links.push(nl)
    }
  }
  return links
}

// Levenshtein distance between two strings
function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// Normalized similarity: 1 = identical, 0 = completely different
function levenshteinSimilarity(a, b) {
  const la = a.toLowerCase().replace(/\.\.\.$/, '').trim()
  const lb = b.toLowerCase().replace(/\.\.\.$/, '').trim()
  // Check if shorter string is a prefix of the longer one
  const shorter = la.length <= lb.length ? la : lb
  const longer = la.length <= lb.length ? lb : la
  if (longer.startsWith(shorter)) return 1
  const dist = levenshtein(la, lb)
  return 1 - dist / Math.max(la.length, lb.length)
}

// What fraction of shorter's tokens appear in longer (exact or prefix match)?
function containmentRatio(shorter, longer) {
  if (shorter.length === 0) return 0
  const setL = new Set(longer)
  let hits = 0
  for (const t of shorter) {
    if (setL.has(t)) { hits++; continue }
    // Prefix match: "godz" matches "godzinnym", "piekar" matches "piekarsk"
    if (longer.some(l => l.startsWith(t) || t.startsWith(l))) hits++
  }
  return hits / shorter.length
}

function isDuplicate(a, b) {
  const jaccard = jaccardSimilarity(a.name, b.name)
  const locMatch = citiesMatch(a.location, b.location)

  if (jaccard > 0.6) return true
  if (locMatch && jaccard > 0.35) return true
  if (locMatch && tokenize(a.name).length <= 3 && tokenize(b.name).length <= 3 && jaccard > 0.25) return true

  // Short-vs-long name with same city: if ≥75% of the short side's tokens
  // appear in the long side (exact or prefix), it's likely a truncated duplicate.
  // Catches maratonypolskie short/truncated names vs other sources' full titles.
  if (locMatch) {
    const tokA = tokenize(a.name)
    const tokB = tokenize(b.name)
    if (tokA.length >= 2 && tokB.length >= 2) {
      if (tokA.length <= tokB.length && tokA.length <= 5 && containmentRatio(tokA, tokB) >= 0.75) return true
      if (tokB.length <= tokA.length && tokB.length <= 5 && containmentRatio(tokB, tokA) >= 0.75) return true
    }
  }

  // Last resort: same city + raw string similarity (catches glued words, truncations)
  if (locMatch && levenshteinSimilarity(a.name, b.name) >= 0.55) return true

  return false
}

async function main() {
  console.log(dryRun ? '=== DRY RUN (use --apply to execute) ===' : '=== APPLYING DEDUP ===')

  // Fetch all rows from scraper_all
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('*')
      .range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Loaded ${allRows.length} rows from scraper_all`)

  // Group by date for efficient comparison
  const byDate = new Map()
  for (const row of allRows) {
    const group = byDate.get(row.date) || []
    group.push(row)
    byDate.set(row.date, group)
  }

  const toDelete = new Set()
  const merges = [] // { winner, loser }

  for (const [date, rows] of byDate) {
    if (rows.length < 2) continue

    // Sort by priority (best first) so winner is always the higher-priority source
    rows.sort((a, b) => getPriority(a.source) - getPriority(b.source))

    for (let i = 0; i < rows.length; i++) {
      if (toDelete.has(rows[i].id)) continue

      for (let j = i + 1; j < rows.length; j++) {
        if (toDelete.has(rows[j].id)) continue

        if (isDuplicate(rows[i], rows[j])) {
          merges.push({ winner: rows[i], loser: rows[j] })
          toDelete.add(rows[j].id)
        }
      }
    }
  }

  console.log(`\nFound ${merges.length} duplicates to merge:\n`)

  for (const { winner, loser } of merges) {
    const jac = jaccardSimilarity(winner.name, loser.name).toFixed(2)
    const lev = levenshteinSimilarity(winner.name, loser.name).toFixed(2)
    const loc = citiesMatch(winner.location, loser.location) ? 'city✓' : 'city✗'
    console.log(`\n  ${winner.date} | ${winner.location || '?'} [${loc} j=${jac} l=${lev}]`)
    console.log(`    ✓ KEEP   [${winner.source.padEnd(20)}] ${winner.name}`)
    console.log(`    ✗ DELETE [${loser.source.padEnd(20)}] ${loser.name}`)
  }

  if (dryRun) {
    console.log(`\n=== DRY RUN COMPLETE — ${merges.length} duplicates found, nothing changed ===`)
    console.log('Run with --apply to execute')
    return
  }

  // Apply merges
  let merged = 0, errors = 0
  for (const { winner, loser } of merges) {
    // Fill empty fields on winner from loser
    const updates = {}
    for (const key of MERGE_FIELDS) {
      if (isEmpty(winner[key]) && !isEmpty(loser[key])) {
        updates[key] = loser[key]
      }
    }

    // Merge source_links
    updates.source_links = mergeSourceLinks(winner.source_links, loser.source_links)
    updates.merged_at = new Date().toISOString()

    const { error: updateErr } = await supabase
      .from('scraper_all')
      .update(updates)
      .eq('id', winner.id)

    if (updateErr) {
      console.error(`  ERR updating ${winner.id}: ${updateErr.message}`)
      errors++
      continue
    }

    const { error: deleteErr } = await supabase
      .from('scraper_all')
      .delete()
      .eq('id', loser.id)

    if (deleteErr) {
      console.error(`  ERR deleting ${loser.id}: ${deleteErr.message}`)
      errors++
    } else {
      merged++
      process.stdout.write('M')
    }
  }

  console.log(`\n\nDone: merged=${merged} errors=${errors}`)
}

main().catch(console.error)
