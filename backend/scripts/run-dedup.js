import { createClient } from '@supabase/supabase-js'
import { jaccardSimilarity, citiesMatch, tokenize, SOURCE_PRIORITY, distinguishingTags, hasDistinguishingConflict } from '../src/scrapers/dedup.js'
import { writeRunLog } from './lib/run-log.js'

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
  'name', 'registration_deadline', 'location', 'voivodeship',
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

// Same day, same town, plausibly the same race — but NOT similar enough to merge
// automatically. These are reported for human review and never touched.
//
// Auto-merge cannot simply be loosened to cover them: the Krajenka pair below
// scores jaccard 0.250 against a `> 0.25` bar, so catching it by lowering the
// threshold would start merging genuinely different races that share a town and
// a date (a 10 km and its separate kids event, two races in one festival).
//
//   "Bieg Charytatywny 6km"  (b4sport 13053)   <- b4sport's registration-form label
//   "Twój bieg na 6+”"       (herkules 4258)   <- the event's actual name
//   same date 2026-09-19, same city Krajenka, one event, two rows
//
// Name similarity is required, not optional. Distance overlap alone was tried
// as an alternative trigger and is far too weak a signal — it paired "Kibolska
// Dycha" with "Niebieska Fala" purely because both Poznań races run a 10 km, and
// produced 90 candidates of which most were unrelated. Overlap is still shown in
// the report as supporting evidence for pairs that qualify on name.
const REVIEW_MIN_JACCARD = 0.12

function parseDistanceSet(row) {
  const raw = typeof row.distances === 'string' ? row.distances : ''
  return new Set(
    raw.split(/[,;]/)
      .map((d) => d.trim().toLowerCase().replace(/\s+/g, ''))
      .filter(Boolean),
  )
}

function distancesOverlap(a, b) {
  const setA = parseDistanceSet(a)
  const setB = parseDistanceSet(b)
  if (setA.size === 0 || setB.size === 0) return false
  return [...setA].some((d) => setB.has(d))
}

// hasDistinguishingConflict is deliberately strict for AUTO-MERGE: it treats
// style:{nw,trail} vs style:{nw} as a conflict. For review that is wrong — a
// subset means one source simply saw more sub-races than the other, which is
// the normal shape of a cross-source duplicate. The Krajenka pair is exactly
// this and was invisible until the rule was relaxed here.
//
// A genuinely DISJOINT set in a category (distance:half vs distance:full) still
// excludes the pair, as does a one-sided kids: tag — a kids-named race is a
// different event, not a less-complete view of the same one.
function hasHardConflict(tagsA, tagsB) {
  const categories = new Set()
  for (const t of [...tagsA, ...tagsB]) categories.add(t.split(':')[0])
  for (const cat of categories) {
    const inA = [...tagsA].filter((t) => t.startsWith(cat + ':'))
    const inB = [...tagsB].filter((t) => t.startsWith(cat + ':'))
    if (inA.length === 0 || inB.length === 0) {
      if (cat === 'kids') return true
      continue
    }
    const aSubsetB = inA.every((t) => inB.includes(t))
    const bSubsetA = inB.every((t) => inA.includes(t))
    if (!aSubsetB && !bSubsetA) return true
  }
  return false
}

function isReviewCandidate(a, b) {
  if (hasHardConflict(distinguishingTags(a), distinguishingTags(b))) return false
  if (!citiesMatch(a.location, b.location)) return false
  return jaccardSimilarity(a.name, b.name) >= REVIEW_MIN_JACCARD
}

function isDuplicate(a, b) {
  // Distinguishing-tag guard: if A and B have conflicting semantic tags
  // (audience: kids vs adult, distance: full vs half vs quarter,
  // style: trail/nw/ocr/ultra), they are NOT duplicates regardless of
  // name similarity. Mirrors the guard in findScraperAllMatch so the
  // raw→scraper_all merge and within-scraper_all dedup agree on what
  // counts as the same event.
  if (hasDistinguishingConflict(distinguishingTags(a), distinguishingTags(b))) return false

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
  const startedAt = new Date().toISOString()
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
  const reviewCandidates = [] // { a, b } — never merged, reported for a human

  for (const [date, rows] of byDate) {
    if (rows.length < 2) continue

    // Sort by created_at (oldest first = already enriched), then source priority as tiebreaker
    rows.sort((a, b) => {
      const aDate = a.created_at ? new Date(a.created_at).getTime() : Infinity
      const bDate = b.created_at ? new Date(b.created_at).getTime() : Infinity
      if (aDate !== bDate) return aDate - bDate
      return getPriority(a.source) - getPriority(b.source)
    })

    for (let i = 0; i < rows.length; i++) {
      if (toDelete.has(rows[i].id)) continue

      for (let j = i + 1; j < rows.length; j++) {
        if (toDelete.has(rows[j].id)) continue

        if (isDuplicate(rows[i], rows[j])) {
          merges.push({ winner: rows[i], loser: rows[j] })
          toDelete.add(rows[j].id)
        } else if (isReviewCandidate(rows[i], rows[j])) {
          reviewCandidates.push({ a: rows[i], b: rows[j] })
        }
      }
    }
  }

  console.log(`\nFound ${merges.length} duplicates to merge:\n`)

  const RICHNESS_FIELDS = [
    'location', 'voivodeship', 'lat', 'lng', 'distances',
    'registration_url', 'regulamin_url', 'regulamin_urls', 'website',
    'event_type', 'event_types', 'registration_deadline', 'is_kids',
  ]

  for (const { winner, loser } of merges) {
    const jac = jaccardSimilarity(winner.name, loser.name).toFixed(2)
    const lev = levenshteinSimilarity(winner.name, loser.name).toFixed(2)
    const loc = citiesMatch(winner.location, loser.location) ? 'city✓' : 'city✗'
    console.log(`\n  ${winner.date} | ${winner.location || '?'} [${loc} j=${jac} l=${lev}]`)
    const wAdded = winner.created_at ? new Date(winner.created_at).toISOString().slice(0, 10) : '?'
    const lAdded = loser.created_at ? new Date(loser.created_at).toISOString().slice(0, 10) : '?'
    console.log(`    ✓ KEEP   [${winner.source.padEnd(20)}] (added ${wAdded}) ${winner.name}`)
    console.log(`    ✗ DELETE [${loser.source.padEnd(20)}] (added ${lAdded}) ${loser.name}`)

    // Show field richness comparison
    const winnerFields = []
    const loserFields = []
    const loserOnly = [] // fields loser has that winner doesn't — would be merged
    for (const f of RICHNESS_FIELDS) {
      const wHas = !isEmpty(winner[f])
      const lHas = !isEmpty(loser[f])
      if (wHas) winnerFields.push(f)
      if (lHas) loserFields.push(f)
      if (!wHas && lHas) loserOnly.push(f)
    }
    console.log(`    ✓ fields (${winnerFields.length}/${RICHNESS_FIELDS.length}): ${winnerFields.join(', ') || '(none)'}`)
    console.log(`    ✗ fields (${loserFields.length}/${RICHNESS_FIELDS.length}): ${loserFields.join(', ') || '(none)'}`)
    if (loserOnly.length > 0) {
      console.log(`    ← merge  : ${loserOnly.join(', ')}`)
    }
  }

  if (reviewCandidates.length > 0) {
    console.log(`\n\nPossible duplicates — NOT merged, review by hand (${reviewCandidates.length}):`)
    for (const { a, b } of reviewCandidates) {
      const jac = jaccardSimilarity(a.name, b.name).toFixed(2)
      const dist = distancesOverlap(a, b) ? ' distances✓' : ''
      console.log(`\n  ${a.date} | ${a.location || '?'} [j=${jac}${dist}]`)
      console.log(`    ? [${a.source.padEnd(20)}] ${a.name}`)
      console.log(`    ? [${b.source.padEnd(20)}] ${b.name}`)
    }
  }

  if (dryRun) {
    console.log(`\n=== DRY RUN COMPLETE — ${merges.length} duplicates found, nothing changed ===`)
    console.log('Run with --apply to execute')
    return
  }

  // Apply merges
  let merged = 0, errors = 0
  for (const { winner, loser } of merges) {
    // Fill empty fields on winner from loser — winner keeps all its existing values
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

  const logFile = await writeRunLog('dedup', {
    script: 'dedup',
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    total_rows_loaded: allRows.length,
    duplicates_found: merges.length,
    merged,
    errors,
    merges: merges.map(({ winner, loser }) => ({
      date: winner.date,
      location: winner.location,
      winner: { id: winner.id, source: winner.source, name: winner.name },
      loser: { id: loser.id, source: loser.source, name: loser.name },
    })),
  })
  console.log(`Run log: ${logFile}`)
}

main().catch(console.error)
