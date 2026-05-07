import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeRunLog } from './lib/run-log.js'
import { AI_FILLABLE, fieldsNeedingFill, applyRegistryUpdates } from './lib/ai-fillable.js'

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-search.js
// Uses local Claude CLI with web search to find event websites, distances,
// and types for scraper_all events missing data.
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
  // Build the "fields to fill" block dynamically — only what's null on the row.
  const fieldsBlock = fields
    .map(f => `  "${f}": ${AI_FILLABLE[f].promptHint}, or null`)
    .join(',\n')

  return `Search the web for this Polish running event and fill in the missing fields.

EVENT:
  name: ${event.name}
  date: ${event.date}
KNOWN:
  ${describeKnown(event)}

Find the event's official website / registration page. Verify content matches the event name + date before relying on it.

Return ONLY valid JSON, no other text. Include EXACTLY these keys (use null when you cannot determine a value from real source content):
{
${fieldsBlock}
}

GLOBAL RULES:
- Return actual URLs you verified — NEVER fabricate.
- If you cannot find the event at all, return all nulls.
- Polish event types — NEVER use "bieg". Use "nie-bieg" for non-running events (cycling, triathlon, MTB, walking march, orienteering).
- Facebook page is acceptable as "website" when no organizer domain exists.
- Distances: "21.1 km" for półmaraton, "42.2 km" for maraton; comma-separated.
- Prices in PLN integer złote; price_from ≤ price_to.
- registration_deadline: YYYY-MM-DD, within 1 year of event date.
- is_kids: only set true if a dedicated kids race exists; otherwise null.
- voivodeship: exact spelling, one of the 16 Polish voivodeships.`
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
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 }
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

    // Process if type or distances are missing.
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

    // Need enrichment if ANY AI-fillable field is null on this row
    return Object.values(AI_FILLABLE).some(def => def.isEmpty(r))
  })

  const toProcess = limitArg ? needsWork.slice(0, limitArg) : needsWork
  console.log(`Source: ${sourceArg || 'all'}`)
  console.log(`Found ${allRows.length} total, ${needsWork.length} need enrichment, processing ${toProcess.length}\n`)

  let enriched = 0, skipped = 0, failed = 0, flagged = 0

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i]
    console.log(`[${i + 1}/${toProcess.length}] ${row.name} | ${row.date} | ${row.location || '?'}`)

    // Determine which fields to ask the LLM about (only ones that are null on the row)
    const fieldsToFill = fieldsNeedingFill(row)

    const prompt = buildPrompt(row, fieldsToFill)
    const result = callClaude(prompt)

    // Stamp as checked (even if no data found) to avoid re-processing
    if (!dryRun) {
      await supabase.from('scraper_all').update({ enriched_search_at: new Date().toISOString() }).eq('id', row.id)
    }

    if (!result) {
      console.log('    SKIP: Claude returned no data')
      failed++
      failures.push({ id: row.id, name: row.name, reason: 'claude_no_data' })
      continue
    }

    // Check for non-running flag (special: bypasses normal validation)
    if (Array.isArray(result.event_types) && result.event_types.includes('nie-bieg')) {
      console.log(`    FLAG: not a running event — ${JSON.stringify(result.event_types)}`)
      flagged++
      events.push({ id: row.id, name: row.name, status: 'flagged_not_running' })
      continue
    }

    // Apply registry-driven validation
    const updates = applyRegistryUpdates(row, result, fieldsToFill)

    if (Object.keys(updates).length === 0) {
      console.log('    SKIP: nothing new found')
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
  console.log(`  flagged (not running): ${flagged}`)
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
      flagged,
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
