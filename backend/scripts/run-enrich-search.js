import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-search.js
// Uses local Claude CLI with web search to find event websites, distances,
// and types for scraper_all events missing data.
//
// Options:
//   --limit <n>       Max events to process (default: all)
//   --apply           Write results to DB (default: dry run)
//   --source <name>   Source to process (default: maratonypolskie)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const VALID_EVENT_TYPES = ['uliczny', 'przełajowy', 'górski', 'nocny', 'ocr', 'nordic walking', 'ultra', 'charytatywny']

const args = process.argv.slice(2)
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null
const dryRun = !args.includes('--apply')
const sourceArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : null

function buildPrompt(event) {
  return `Search the web for this Polish running event and extract structured data.

Event name: ${event.name}
Event date: ${event.date}
Event location: ${event.location || 'unknown'}
Currently known distances: ${event.distances || 'unknown'}
Currently known types: ${(event.event_types && event.event_types.length > 0) ? event.event_types.join(', ') : 'unknown'}

Find the event's official website and registration page.
From the event page, extract race distances and classify the event type.

Return ONLY valid JSON, no other text:
{
  "website": "https://example.pl" or null,
  "registration_url": "https://example.pl/zapisy" or null,
  "distances": "5 km, 10 km" or null,
  "event_type": ["uliczny", "przełajowy", etc.] or []
}

EVENT TYPE RULES — classify into one or more:
- "uliczny" — road/city race, asphalt, PZLA certified, sidewalks, cycling paths
- "przełajowy" — cross-country, park trails, mixed surface (partial asphalt + grass/dirt), flat terrain
- "górski" — mountain/trail race, significant elevation, mountain paths
- "nocny" — night race, starts after 20:00
- "ocr" — obstacle course race
- "nordic walking" — has nordic walking category
- "ultra" — any distance over 50 km or timed events (6h, 12h, 24h)
- "charytatywny" — charity event, proceeds go to a cause

DISTANCE FORMAT: comma-separated, e.g. "5 km, 10 km, 21.1 km". Use "21.1 km" for półmaraton, "42.2 km" for maraton.

IMPORTANT:
- Return actual URLs you found, not guesses
- If you cannot find the event at all, return all nulls and empty arrays
- NEVER use "bieg" as event type
- If the event is a walk/march, orienteering, triathlon, cycling, or non-running event, set event_type to ["nie-bieg"] so we can filter it out
- If you only find a Facebook page/event for this race and no official website, use the Facebook URL as the "website" value — it's still useful`
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
  console.log(dryRun ? '=== DRY RUN (use --apply to write to DB) ===' : '=== APPLYING ===')

  // Fetch scraper_all rows and filter in-memory.
  const allFlag = process.argv.includes('--all')
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    let query = supabase
      .from('scraper_all')
      .select('id, name, date, location, source, distances, event_types, is_kids, website, registration_url, enriched_search_at')
    if (!allFlag) {
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
    const noType = (!r.event_types || r.event_types.length === 0) && !r.is_kids
    const noDist = !r.distances || r.distances.trim() === ''
    const noRegUrl = !r.registration_url

    return noType || noDist || noRegUrl
  })

  const toProcess = limitArg ? needsWork.slice(0, limitArg) : needsWork
  console.log(`Source: ${sourceArg || 'all'}`)
  console.log(`Found ${allRows.length} total, ${needsWork.length} need enrichment, processing ${toProcess.length}\n`)

  let enriched = 0, skipped = 0, failed = 0, flagged = 0

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i]
    console.log(`[${i + 1}/${toProcess.length}] ${row.name} | ${row.date} | ${row.location || '?'}`)

    const prompt = buildPrompt(row)
    const result = callClaude(prompt)

    // Stamp as checked (even if no data found) to avoid re-processing
    if (!dryRun) {
      await supabase.from('scraper_all').update({ enriched_search_at: new Date().toISOString() }).eq('id', row.id)
    }

    if (!result) {
      console.log('    SKIP: Claude returned no data')
      failed++
      continue
    }

    // Check for non-running flag
    if (result.event_type && result.event_type.includes('nie-bieg')) {
      console.log(`    FLAG: not a running event — ${JSON.stringify(result.event_type)}`)
      flagged++
      continue
    }

    const updates = {}

    // Website
    if (result.website && !row.website) {
      updates.website = result.website
    }

    // Registration URL
    if (result.registration_url && !row.registration_url) {
      updates.registration_url = result.registration_url
    }

    // Distances — replace if missing
    if (result.distances && (!row.distances || row.distances.trim() === '')) {
      updates.distances = result.distances
    }

    // Event types — add if missing
    if (result.event_type && Array.isArray(result.event_type) && result.event_type.length > 0) {
      const valid = result.event_type.filter(t => VALID_EVENT_TYPES.includes(t))
      if (valid.length > 0 && (!row.event_types || row.event_types.length === 0)) {
        updates.event_types = valid
      }
    }

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
        continue
      }
    }

    enriched++

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
}

main().catch(console.error)
