import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeRunLog } from './lib/run-log.js'
import { pickFillable, fieldsNeedingFill, applyRegistryUpdates } from './lib/ai-fillable.js'

// This script has ONE job: find the two source-of-truth URLs for an event —
// its registration page and its regulamin (rules) PDF. It does NOT extract
// distances, prices, types, deadlines or any other field. Field extraction is
// the job of run-enrich-from-regulamin.js, which reads the regulamin PDF that
// THIS script locates. Keep the two responsibilities separate.
const SEARCH_FILLABLE = pickFillable(['registration_url', 'regulamin_url'])

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-search.js
// Uses local Claude CLI with web search to find each event's registration page
// and regulamin (rules) PDF — and nothing else. Organizer websites are NOT
// searched (low-yield; see ai-fillable.js for why `website` was removed).
// Run run-enrich-from-regulamin.js AFTER this to mine the regulamin PDF for
// distances / prices / deadline / types / kids.
//
// SCOPE (default, since 2026-05-06):
//   Processes scraper_all rows merged TODAY (merged_at >= start of today
//   in UTC). This matches the daily pipeline cadence — every nightly run
//   enriches just the new arrivals. Pre-publish rows are NOT skipped —
//   today's new events go through enrich-search before publish so the
//   pending CE row created at publish time already has the enrichment.
//
// Options:
//   --limit <n>          Max events to process (default: all)
//   --apply              Write results to DB (default: dry run)
//   --source <name>      Source filter (e.g. 'protiming24')
//   --pending-only       LEGACY scope — only rows whose CE is status='pending'.
//                        Use to backfill admin's review queue without
//                        re-touching today's brand-new rows.
//   --all-incomplete     WIDE scope — every scraper_all row that looks
//                        incomplete, ignoring merged_at AND calendar_events
//                        status. Use sparingly (Claude API spend); will
//                        hit hundreds of already-active events.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)


const args = process.argv.slice(2)
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null
const dryRun = !args.includes('--apply')
const sourceArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : null

function describeKnown(event) {
  const known = []
  if (event.location) known.push(`location: ${event.location}`)
  if (event.voivodeship) known.push(`voivodeship: ${event.voivodeship}`)
  if (event.distances) known.push(`distances: ${event.distances}`)
  if (event.event_types && event.event_types.length) known.push(`types: ${event.event_types.join(', ')}`)
  if (event.website) known.push(`website: ${event.website}`)
  if (event.registration_url) known.push(`registration_url: ${event.registration_url}`)
  return known.length ? known.join('\n  ') : '(none — only name + date)'
}

function buildPrompt(event, fields) {
  // Only the URL fields that are still missing on this row.
  const fieldsBlock = fields
    .map(f => {
      const def = SEARCH_FILLABLE[f]
      const hint = typeof def.promptHint === 'function' ? def.promptHint(event) : def.promptHint
      return `  "${f}": ${hint}, or null`
    })
    .join(',\n')

  // Extract simple city/year strings for query templates
  const year = (event.date || '').slice(0, 4)
  const city = (event.location || '').split(/[,\n]/)[0].trim()
  const cityDomain = city
    ? city.toLowerCase()
        .replace(/[ąćęłńóśźż]/g, ch => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[ch] || ch))
        .replace(/[^a-z]/g, '')
    : ''

  const wantReg = fields.includes('registration_url')
  const wantReg2 = fields.includes('regulamin_url')
  const target = [wantReg && 'the registration / sign-up page', wantReg2 && 'the regulamin (rules) PDF']
    .filter(Boolean).join(' and ')

  return `You are locating verified source URLs for a Polish running event. Your ONLY job is to find ${target}. Do NOT extract distances, prices, types, dates, kids info or any other field — return ONLY the URL(s). Those other fields are extracted later from the regulamin PDF you find here.

EVENT
  name: ${event.name}
  date: ${event.date}
  location: ${event.location || '(unknown)'}
  known fields: ${describeKnown(event)}

SEARCH STRATEGY — run multiple queries, accumulate candidates:
  1. "${event.name}" ${city} ${year}                                            [strict, exact phrase]
  2. ${event.name} ${city} ${year}                                              [loose, no quotes — use when (1) returns nothing]
  3. ${cityDomain ? `${cityDomain}.pl ${event.name}` : '<city>.pl <name>'}                                                  [municipal site, often hosts event announcements]
  4. site:b4sportonline.pl OR site:datasport.pl OR site:dostartu.pl OR site:elektronicznezapisy.pl OR site:zmierzymyczas.pl OR site:plus-timing.pl OR site:online.datasport.pl ${event.name}     [direct hit on registration platforms → registration_url]
  5. ${event.name} ${year} regulamin                                            [direct rules hit → regulamin_url]
  6. "${event.name}" filetype:pdf                                               [regulamin PDF → regulamin_url]

CANDIDATE VERIFICATION (mandatory before trusting any URL):
  - Fetch the page (or PDF — extract text) and confirm:
    a. event name appears (case-insensitive substring or 80%+ token overlap with the EVENT name above; Polish letters: ą→a, ć→c, etc. for matching)
    b. event date matches OR same day-month combo (±1 day)
    c. location matches (city name appears, or nearby)
  - If all three match → URL verified.
  - If date or city does NOT match → reject (it's a different edition or different event with similar name).

WHAT GOES IN EACH FIELD:
  - registration_url → the page where a runner signs up (b4sportonline.pl/<event>/, dostartu.pl/permalink-vXXXXX, zmierzymyczas.pl/<id>/<slug>.html, elektronicznezapisy.pl/event/XXX, online.datasport.pl/zapisy/portal/zawody.php?zawody=NN, or the organizer's own sign-up form).
  - regulamin_url → the official rules document, ideally a direct PDF link ("regulamin", "regulamin.pdf").
  SKIP these as sources (listings, not source-of-truth, confirm nothing):
  - maratonypolskie.pl, kalendarzbiegowy.pl, zawodybiegowe.pl, zapisysportowe.pl

PATTERN — prior-year edition → new-year edition:
  If you find a previous-year edition like "5. <event>" at zmierzymyczas.pl/2228/5-<slug>.html, search for the same slug stem on the same platform — usually a new ID exists for the next edition (zmierzymyczas.pl/2508/6-<slug>.html). Same trick on dostartu, datasport, b4sport.

OUTPUT — return ONLY valid JSON, no other text:
{
${fieldsBlock}
}

GLOBAL RULES:
- NEVER fabricate URLs. Every URL must come from a real verified page.
- If verification fails OR the event has no online presence (small local race) → return null for that field. Don't guess.
- Return ONLY the requested URL field(s). Ignore every other piece of data on the pages you visit.`
}

let totalCostUsd = 0
let totalInputTokens = 0
let totalOutputTokens = 0

function callClaude(prompt) {
  const promptFile = join(tmpdir(), `search-prompt-${Date.now()}.txt`)

  try {
    writeFileSync(promptFile, prompt, 'utf-8')
    const raw = execSync(
      `cat "${promptFile}" | claude -p --model sonnet --output-format json`,
      { encoding: 'utf-8', timeout: 300000, maxBuffer: 2 * 1024 * 1024 }
    )

    const response = JSON.parse(raw)
    const cost = response.total_cost_usd || 0
    const input = response.usage?.input_tokens || 0
    const output = response.usage?.output_tokens || 0
    const cacheRead = response.usage?.cache_read_input_tokens || 0
    totalCostUsd += cost
    totalInputTokens += input + cacheRead
    totalOutputTokens += output
    console.log(`    tokens: ${input + cacheRead} in / ${output} out | cost: $${cost.toFixed(4)}`)

    const text = response.result || ''
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '')
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      return JSON.parse(match[0])
    }
    console.log(`    Claude raw: ${text.slice(0, 200)}`)
  } catch (err) {
    console.error(`    Claude error: ${err.message?.slice(0, 200)}`)
  } finally {
    try { unlinkSync(promptFile) } catch {}
  }
  return null
}

async function main() {
  const startedAt = new Date().toISOString()
  console.log(dryRun ? '=== DRY RUN (use --apply to write to DB) ===' : '=== APPLYING ===')
  const events = []
  const failures = []

  // Scope flags (mutually exclusive in practice — checked in priority order):
  //   --all-incomplete : process every incomplete scraper_all row (no date,
  //                      no CE filter)
  //   --pending-only   : only rows mapping to a pending CE row (legacy
  //                      behavior, useful for backfilling admin review queue)
  //   default          : rows merged TODAY (merged_at >= start-of-today)
  const allIncompleteFlag = process.argv.includes('--all-incomplete')
  const pendingOnlyFlag = process.argv.includes('--pending-only')
  let pendingKeys = null
  let useMergedAtFilter = false

  if (allIncompleteFlag) {
    console.log(`Scope: --all-incomplete — every scraper_all row that looks incomplete (DOES NOT respect calendar_events status, ignores merged_at)`)
  } else if (pendingOnlyFlag) {
    const pendingRows = []
    let pFrom = 0
    while (true) {
      const { data, error } = await supabase
        .from('calendar_events')
        .select('source, source_id, source_links')
        .eq('status', 'pending')
        .range(pFrom, pFrom + 999)
      if (error) { console.error('Pending fetch failed:', error.message); process.exit(1) }
      if (!data || data.length === 0) break
      pendingRows.push(...data)
      if (data.length < 1000) break
      pFrom += 1000
    }
    pendingKeys = new Set()
    for (const r of pendingRows) {
      if (r.source && r.source_id) pendingKeys.add(`${r.source}:${r.source_id}`)
      // also include any source from the merged source_links — scraper_all rows can
      // have a different primary source than the published calendar_events row
      for (const l of (r.source_links || [])) {
        if (l.source && l.source_id) pendingKeys.add(`${l.source}:${l.source_id}`)
      }
    }
    console.log(`Scope: --pending-only (${pendingKeys.size} source-id pairs match a pending row)`)
  } else {
    // DEFAULT: today's merges only — picks up just-arrived events for the
    // daily pipeline. Server-side filter on merged_at to keep the fetch small.
    useMergedAtFilter = true
    console.log(`Scope: default — scraper_all rows merged today (merged_at >= ${new Date().toISOString().split('T')[0]})`)
  }
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    let query = supabase
      .from('scraper_all')
      .select('id, name, date, location, voivodeship, source, source_id, distances, event_types, is_kids, website, registration_url, regulamin_url, price_from, price_to, registration_deadline, enriched_search_at')
    if (useMergedAtFilter) {
      query = query.gte('merged_at', new Date().toISOString().split('T')[0])
    }
    const { data, error } = await query.range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); process.exit(1) }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

    // Process rows missing a registration_url or regulamin_url.
    // Skip already-searched rows.
  const today = new Date().toISOString().split('T')[0]
  const needsWork = allRows.filter(r => {
    if (sourceArg && r.source !== sourceArg) return false
    if (r.enriched_search_at) return false
    if (r.date && r.date < today) return false

    // Pending-only scope: skip unless this scraper_all row maps to a
    // pending calendar_events row (by primary source+id or via source_links).
    if (pendingKeys && r.source && r.source_id && !pendingKeys.has(`${r.source}:${r.source_id}`)) {
      return false
    }

    // Need a search only if a registration_url or regulamin_url is still missing
    return Object.values(SEARCH_FILLABLE).some(def => def.isEmpty(r))
  })

  const toProcess = limitArg ? needsWork.slice(0, limitArg) : needsWork
  console.log(`Source: ${sourceArg || 'all'}`)
  console.log(`Found ${allRows.length} total, ${needsWork.length} need enrichment, processing ${toProcess.length}\n`)

  let enriched = 0, skipped = 0, failed = 0

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i]
    console.log(`[${i + 1}/${toProcess.length}] ${row.name} | ${row.date} | ${row.location || '?'}`)

    // Which URL(s) are still missing on this row
    const fieldsToFill = fieldsNeedingFill(row, SEARCH_FILLABLE)

    const prompt = buildPrompt(row, fieldsToFill)
    const result = callClaude(prompt)

    // Stamp as checked (even if no URL found) to avoid re-processing
    if (!dryRun) {
      await supabase.from('scraper_all').update({ enriched_search_at: new Date().toISOString() }).eq('id', row.id)
    }

    if (!result) {
      console.log('    SKIP: Claude returned no data')
      failed++
      failures.push({ id: row.id, name: row.name, reason: 'claude_no_data' })
      continue
    }

    // Validate + keep only the URL fields we asked for
    const updates = applyRegistryUpdates(row, result, fieldsToFill, SEARCH_FILLABLE)

    if (Object.keys(updates).length === 0) {
      console.log('    SKIP: no URL found')
      skipped++
      continue
    }

    // Log what we found
    for (const [k, v] of Object.entries(updates)) {
      const old = row[k] || '(none)'
      console.log(`    ${dryRun ? 'WOULD' : '✓'} ${k}: ${Array.isArray(old) ? old.join(', ') : old} → ${Array.isArray(v) ? v.join(', ') : v}`)
    }

    if (!dryRun) {
      const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
      if (error) {
        console.error(`    ERR: ${error.message}`)
        failed++
        failures.push({ id: row.id, name: row.name, reason: 'db_update_failed', message: error.message })
        continue
      }
    }

    enriched++
    events.push({ id: row.id, name: row.name, status: 'enriched', updates })

    // Delay between Claude calls
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`\n=== ${dryRun ? 'DRY RUN' : 'DONE'} ===`)
  console.log(`  enriched: ${enriched}`)
  console.log(`  skipped: ${skipped}`)
  console.log(`  failed: ${failed}`)
  console.log(`  total cost: $${totalCostUsd.toFixed(4)}`)
  console.log(`  total tokens: ${totalInputTokens} in / ${totalOutputTokens} out`)

  if (!dryRun) {
    const logFile = await writeRunLog('enrich-search', {
      script: 'enrich-search',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      args: { limit: limitArg, source: sourceArg, all_incomplete: allIncompleteFlag, pending_only: pendingOnlyFlag },
      candidates_total: allRows.length,
      candidates_needs_work: needsWork.length,
      processed: toProcess.length,
      enriched,
      skipped,
      failed,
      cost_usd: Number(totalCostUsd.toFixed(4)),
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      events,
      failures,
    })
    console.log(`Run log: ${logFile}`)
  }
}

main().catch(console.error)
