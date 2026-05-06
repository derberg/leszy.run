import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AI_FILLABLE, pickFillable, fieldsNeedingFill, applyRegistryUpdates } from './lib/ai-fillable.js'

// Subset of AI_FILLABLE that's plausibly extractable from a regulamin PDF.
// Excludes URLs (PDF doesn't contain its own URL or external pages reliably)
// and event_types/distances (those have their own purpose-built prompt below).
const PDF_FILLABLE = pickFillable([
  'location', 'voivodeship',
  'price_from', 'price_to',
  'registration_deadline',
  'is_kids',
])

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-from-regulamin.js
// Finds scraper_all entries that have a regulamin URL,
// fetches the PDF, and uses local Claude to extract distances and event type.
//
// Behavior:
// - distances: Claude's PDF extraction REPLACES scraper distances (PDF is authoritative)
// - event_types: Claude's types are MERGED with existing (additive only)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const VALID_EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic walking', 'ultra', 'charytatywny', 'uliczny']

// Normalize type names Claude might return
const TYPE_NORMALIZE = { 'nordic': 'nordic walking', 'bieg': null, 'inny': null }

// Types that describe the terrain/format — only one should apply
const TERRAIN_TYPES = new Set(['trail', 'ocr', 'uliczny'])

// Merge new types into existing, but don't mix conflicting terrain types
function mergeEventTypes(existing, incoming) {
  const merged = new Set(existing)
  const existingTerrain = existing.filter(t => TERRAIN_TYPES.has(t))

  for (const t of incoming) {
    if (TERRAIN_TYPES.has(t) && existingTerrain.length > 0 && !existingTerrain.includes(t)) {
      // Skip — would contradict existing terrain type (e.g. uliczny + trail)
      continue
    }
    merged.add(t)
  }

  return [...merged]
}

function checkClaudeCli() {
  try {
    execSync('claude --version', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function downloadPdf(url) {
  const tmpFile = join(tmpdir(), `regulamin-${Date.now()}.pdf`)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('pdf')) return { error: `not PDF (${contentType})` }

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 500) return { error: `too small (${buffer.length} bytes)` }

    // Detect HTML served as PDF (dostartu SPA shells)
    const head = buffer.slice(0, 100).toString('utf-8').trim()
    if (head.startsWith('<!doctype') || head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
      return { error: 'HTML served as PDF (SPA shell)' }
    }

    writeFileSync(tmpFile, buffer)
    return { path: tmpFile }
  } catch (err) {
    return { error: err.message?.slice(0, 100) || 'unknown' }
  }
}

function buildPrompt(event) {
  const currentDistances = event.distances && event.distances.trim() ? event.distances : 'unknown'
  const currentTypes = (event.event_types && event.event_types.length > 0) ? event.event_types.join(', ') : 'unknown'

  // Add a "fill these too if you can" section ONLY for fields currently null
  // on the row — driven by the shared registry so any future schema additions
  // propagate without touching this file.
  const extraFields = fieldsNeedingFill(event, PDF_FILLABLE)
  const extraBlock = extraFields.length === 0
    ? ''
    : extraFields.map(f => `  "${f}": ${PDF_FILLABLE[f].promptHint}, or null if not stated`).join(',\n')

  return `You are extracting structured data about a Polish running/walking race event from its official regulations (regulamin) PDF.

Event name: ${event.name}
Event date: ${event.date}
Event location: ${event.location || 'unknown'}
Currently known distances: ${currentDistances}
Currently known event types: ${currentTypes}

Extract from the PDF:
1. DISTANCES — look for "trasa", "dystans", "długość trasy", classification/category names, distance mentions. The PDF is the source of truth — override currently known distances if the PDF says differently.
2. EVENT TYPE — classify based on the ACTUAL course description, surface, and terrain in the PDF.${extraFields.length ? '\n3. ADDITIONAL FACTUAL FIELDS — extract directly from the PDF where stated; null if not present.' : ''}

Return ONLY valid JSON, no other text:
{
  "distances_km": [numbers, e.g. 5, 10, 21.1, 42.2],
  "time_based_distances": ["4h", "6h", "12h"],
  "meter_distances": ["200m", "500m"],
  "event_type": ["one or more from the list below"]${extraFields.length ? ',\n' + extraBlock : ''}
}

DISTANCE RULES:
- Only actual race distances, not age limits, elevation, or other numbers
- półmaraton = 21.1, maraton = 42.2
- time_based_distances for timed ultras (e.g. "bieg 6-godzinny" → "6h")
- meter_distances for short distances under 1 km (e.g. biegi dzieci 200m, 500m)
- If no distances found, use empty array []

EVENT TYPE RULES — you MUST classify every event into at least one type. NEVER use "bieg". Valid types:

- "uliczny" — DEFAULT for most events. Use when: asphalt/road/pavement surface, city streets, certified course (atest PZLA), sidewalks, cycling paths, cobblestone ("kostka brukowa"). If the regulamin describes a paved route through a city/town and no other type fits better, use "uliczny".
- "trail" — off-road/terrain: forest paths ("ścieżki leśne"), dirt trails, mountain trails, cross-country ("przełaj"), mud, gravel paths, significant elevation gain. Keywords: terenowy, górski, leśny, przełajowy, szlak, cross.
- "nocny" — night race. Keywords: nocny, nocna, start after 20:00, headlamp required ("czołówka").
- "ocr" — obstacle course race. Keywords: przeszkody, obstacle, mud run, survival, extreme.
- "nordic walking" — nordic walking category exists alongside running. Keywords: nordic walking, NW, kije/kijki, marsz.
- "ultra" — any running distance over 50 km, or timed events (6h, 12h, 24h). Keywords: ultra, ultramaraton.
- "charytatywny" — charity event. Keywords: charytatywny, cel charytatywny, zbiórka, fundacja, pomagamy, hospicjum.

IMPORTANT: An event can have MULTIPLE types (e.g. ["trail", "nocny"] for a night trail run, ["uliczny", "charytatywny"] for a charity road race, ["uliczny", "nordic"] for a road race with NW category). When in doubt between "uliczny" and "trail", look at the surface description — asphalt/pavement = uliczny, dirt/forest/mountain = trail.`
}

let totalCostUsd = 0
let totalInputTokens = 0
let totalOutputTokens = 0

function callClaudeWithPdf(prompt, pdfPath) {
  const promptFile = join(tmpdir(), `enrich-prompt-${Date.now()}.txt`)

  try {
    writeFileSync(promptFile, prompt, 'utf-8')
    const raw = execSync(
      `cat "${promptFile}" | claude -p --model haiku --output-format json "${pdfPath}"`,
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
    console.log(`    Claude raw output: ${text.slice(0, 200)}`)
  } catch (err) {
    console.error(`  Claude error: ${err.message?.slice(0, 200)}`)
  } finally {
    try { unlinkSync(promptFile) } catch {}
  }
  return null
}

function buildDistancesString(extracted) {
  const parts = []

  if (extracted.distances_km && Array.isArray(extracted.distances_km)) {
    for (const d of extracted.distances_km) {
      if (typeof d === 'number' && d > 0 && d < 500) {
        parts.push(`${Math.round(d * 10) / 10} km`)
      }
    }
  }

  if (extracted.time_based_distances && Array.isArray(extracted.time_based_distances)) {
    for (const t of extracted.time_based_distances) {
      if (/^\d{1,2}h$/i.test(t)) parts.push(t.toLowerCase())
    }
  }

  if (extracted.meter_distances && Array.isArray(extracted.meter_distances)) {
    for (const m of extracted.meter_distances) {
      if (/^\d+m$/i.test(m)) parts.push(m.toLowerCase())
    }
  }

  return parts.length > 0 ? parts.join(', ') : null
}

async function main() {
  if (!checkClaudeCli()) {
    console.error('Claude CLI not available. Install: https://docs.anthropic.com/en/docs/claude-cli')
    process.exit(1)
  }

  const allFlag = process.argv.includes('--all')
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    let query = supabase
      .from('scraper_all')
      .select('id, name, date, location, voivodeship, distances, event_type, event_types, regulamin_url, regulamin_urls, price_from, price_to, registration_deadline, is_kids, enriched_regulamin_at')
      .not('regulamin_url', 'is', null)
      .is('enriched_regulamin_at', null)
    if (!allFlag) {
      query = query.gte('merged_at', new Date().toISOString().split('T')[0])
    }
    const { data, error: fetchErr } = await query.range(from, from + pageSize - 1)

    if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1) }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  // Process rows missing distances OR event types OR ANY PDF-extractable field
  const needsEnrichment = allRows.filter(row => {
    const noDistances = !row.distances || row.distances.trim() === '' || row.distances === '{}'
    const noTypes = !row.event_types || row.event_types.length === 0
    const anyExtraNull = fieldsNeedingFill(row, PDF_FILLABLE).length > 0
    return noDistances || noTypes || anyExtraNull
  })

  console.log(`Found ${allRows.length} rows with regulamin URLs, ${needsEnrichment.length} need enrichment (missing distances or types)`)
  let enriched = 0, skipped = 0, failed = 0

  for (const row of needsEnrichment) {
    const url = row.regulamin_url
    console.log(`\n  ${row.name}`)
    console.log(`    URL: ${url}`)
    console.log(`    current distances: ${row.distances || '(none)'}`)
    console.log(`    current types: ${row.event_types?.join(', ') || '(none)'}`)

    const download = await downloadPdf(url)
    if (download.error) {
      console.log(`    SKIP: ${download.error}`)
      skipped++
      continue
    }
    const pdfPath = download.path

    try {
      const prompt = buildPrompt(row)
      const extracted = callClaudeWithPdf(prompt, pdfPath)

      if (!extracted) {
        console.log('    SKIP: Claude returned no data')
        failed++
        continue
      }

      const updates = {}
      console.log(`    Claude returned: ${JSON.stringify(extracted)}`)

      // Distances — Claude's PDF extraction REPLACES existing (PDF is authoritative)
      const newDistStr = buildDistancesString(extracted)
      if (newDistStr) {
        if (newDistStr !== (row.distances || '')) {
          updates.distances = newDistStr
        }
      } else if (!row.distances || row.distances.trim() === '') {
        console.log('    WARN: distances still missing — Claude found none in PDF')
      }

      // Event types — MERGE but respect conflicts (no trail + uliczny etc.)
      if (extracted.event_type && Array.isArray(extracted.event_type)) {
        const valid = extracted.event_type
          .map(t => TYPE_NORMALIZE[t.toLowerCase()] !== undefined ? TYPE_NORMALIZE[t.toLowerCase()] : t.toLowerCase())
          .filter(t => t && VALID_EVENT_TYPES.includes(t))
        if (valid.length > 0) {
          const existingTypes = row.event_types || []
          const merged = mergeEventTypes(existingTypes, valid)
          if (JSON.stringify(merged.sort()) !== JSON.stringify(existingTypes.sort())) {
            updates.event_types = merged
          }
        }
      }

      // Registry-driven: fill any PDF-fillable null fields the LLM provided
      const extraFields = fieldsNeedingFill(row, PDF_FILLABLE)
      const extraUpdates = applyRegistryUpdates(row, extracted, extraFields, PDF_FILLABLE)
      Object.assign(updates, extraUpdates)

      updates.enriched_regulamin_at = new Date().toISOString()
      if (Object.keys(updates).length > 1) {
        const { error: updateErr } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
        if (updateErr) {
          console.log(`    ERR: ${updateErr.message}`)
          failed++
        } else {
          if (updates.distances) console.log(`    ✓ distances: ${row.distances || '(none)'} → ${updates.distances}`)
          if (updates.event_types) console.log(`    ✓ types: ${row.event_types?.join(', ') || '(none)'} → ${updates.event_types.join(', ')}`)
          for (const k of Object.keys(extraUpdates)) {
            console.log(`    ✓ ${k}: ${row[k] ?? '(none)'} → ${JSON.stringify(extraUpdates[k])}`)
          }
          enriched++
        }
      } else {
        // No data changes, but still stamp as processed
        await supabase.from('scraper_all').update({ enriched_regulamin_at: updates.enriched_regulamin_at }).eq('id', row.id)
        console.log('    SKIP: no changes needed (marked as checked)')
        skipped++
      }
    } finally {
      try { unlinkSync(pdfPath) } catch {}
    }

    await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`\n\nDone: ${enriched} enriched, ${skipped} skipped, ${failed} failed`)
  console.log(`  total cost: $${totalCostUsd.toFixed(4)}`)
  console.log(`  total tokens: ${totalInputTokens} in / ${totalOutputTokens} out`)
}

main().catch(console.error)
