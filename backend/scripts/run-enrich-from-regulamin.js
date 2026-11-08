import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AI_FILLABLE, pickFillable, fieldsNeedingFill, applyRegistryUpdates, fillFreeEntryPrices } from './lib/ai-fillable.js'
import { dropUnsupportedFields } from '../src/lib/extractionEvidence.js'
import { dropsDistances } from './lib/distances.js'
import { resolveRegulaminScope } from './lib/enrichScope.js'
import { acquireRegulamin, fetchDoc } from './lib/regulaminDocument.js'
import { huntRegulamin } from './lib/regulaminHunt.js'

// Subset of AI_FILLABLE that's plausibly extractable from a regulamin PDF.
// Excludes URLs (PDF doesn't contain its own URL or external pages reliably)
// and event_types/distances (those have their own purpose-built prompt below).
// is_kids is handled separately (bidirectional — PDF can both confirm and deny).
const PDF_FILLABLE = pickFillable([
  'location', 'voivodeship',
  'price_from', 'price_to',
  'registration_deadline',
])

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-from-regulamin.js
// Finds scraper_all entries that have a regulamin URL, fetches the regulamin
// (PDF, DOCX, plain HTML page, or a public Google Drive folder of any of those),
// and uses local Claude to extract distances and event type.
//
// Behavior:
// - distances: Claude's extraction REPLACES scraper distances (regulamin is
//   authoritative), unless it ONLY removes distances the scraper found. See dropsDistances()
// - event_types: Claude's types are MERGED with existing (additive only)
//
// Host-only: relies on the `claude` CLI plus macOS `textutil` (docx/html) and
// `pdftotext` — none are in the backend Docker image (same constraint as step 8).
//
// Options:
//   default              Every un-mined row (enriched_regulamin_at IS NULL)
//                        with a regulamin URL, for a race that has not happened
//                        yet. See resolveRegulaminScope() for why the scope is
//                        the event date and not merged_at.
//   --all                Drop the event-date floor too, so past races are mined
//                        as well. That was 1465 rows on 2026-09-29 against 124
//                        for the default, so pair it with --limit.
//   --merged-since <d>   Narrow the default to rows merged on or after <d>
//                        (YYYY-MM-DD, UTC). Use when this host step runs right
//                        after a merge and you want only that merge's rows.
//                        Pair it with the same date given to run-enrich-search.
//   --limit <n>          Stop after n rows. Races are taken soonest first, so a
//                        bounded run clears the most urgent ones.
//   --only <s>:<id>      Mine exactly these rows, repeatable. Neither the event
//                        date nor enriched_regulamin_at is consulted, so this
//                        is how a merged fix reaches the rows it was measured
//                        against: --only b4sport:13127. Soonest-first ordering
//                        puts a 2027 race out of --limit's reach, and clearing
//                        the stamp by hand is a database write for what should
//                        be a rerun.
//
// A regulamin_url whose document is positively not this race's regulamin is
// never left in place. huntRegulamin() first looks for the real one among the
// links of that page, the registration page and the website; found, it
// replaces the URL and is mined instead. Not found, the URL is cleared. (This
// used to need --null-bad-regulamin, so a run without it reported the same 22
// junk URLs on 2026-11-08 that it had reported before and left every one.
// The flag is still accepted and changes nothing.)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

let scope
try {
  scope = resolveRegulaminScope({
    argv: process.argv.slice(2),
    today: new Date().toISOString().split('T')[0],
  })
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const VALID_EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic walking', 'ultra', 'charytatywny', 'uliczny']

// Normalize type names Claude might return
const TYPE_NORMALIZE = { 'nordic': 'nordic walking', 'bieg': null, 'inny': null }

// Types with strong keyword evidence from scrapers — never silently dropped by LLM.
// If the PDF-reading LLM omits one of these, we preserve it and merge rather than replace.
const SPECIFIC_TYPES = new Set(['trail', 'ocr', 'charytatywny', 'nordic walking'])

// Merge PDF-extracted types with existing, treating PDF as authoritative for terrain.
// Preserves SPECIFIC_TYPES that the LLM dropped (hallucination guard).
function mergeEventTypes(existing, incoming) {
  const existingSpecific = existing.filter(t => SPECIFIC_TYPES.has(t))
  const incomingSpecific = incoming.filter(t => SPECIFIC_TYPES.has(t))
  const lostSpecific = existingSpecific.filter(t => !incomingSpecific.includes(t))

  if (lostSpecific.length > 0) {
    // LLM dropped a specific type — preserve it and merge (LLM may have missed it in PDF)
    return [...new Set([...existing, ...incoming])]
  }
  // LLM output is authoritative — replaces existing (e.g. uliczny → trail when PDF is off-road)
  return [...new Set(incoming)]
}

function checkClaudeCli() {
  try {
    execSync('claude --version', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
    return true
  } catch {
    return false
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

  return `You are extracting structured data about a Polish running/walking race event from its official regulations (regulamin) document. The document may be a regulamin PDF, a DOCX, an HTML page, or several regulamin files concatenated together (one per distance) — treat all sections as describing the same event and merge what you find.

Event name: ${event.name}
Event date: ${event.date}
Event location: ${event.location || 'unknown'}
Currently known distances: ${currentDistances}
Currently known event types: ${currentTypes}

Extract from the document:
1. DISTANCES — look for "trasa", "dystans", "długość trasy", classification/category names, distance mentions. The document is the source of truth — override currently known distances if it says differently. If multiple regulamin sections are present, collect distances from ALL of them.
2. EVENT TYPE — current classification: [${currentTypes}]. Verify this against the ACTUAL course description in the document and CORRECT it if wrong (e.g. "uliczny" but the course is on forest paths/trails → change to "trail"; no NW category in the document → remove "nordic walking"). The document is authoritative.
3. IS_KIDS — does this regulamin include a dedicated children's/youth race? true if yes (biegi dla dzieci, separate category for kids/youth under 18, "mini bieg"); false if the regulamin clearly covers only adult/open-age races; null if not mentioned.
4. ATEST — is the course certified (atest PZLA, certyfikat AIMS / World Athletics)? certified: true if the document says the course has, or will have, a valid atest/certificate ("trasa posiada atest PZLA", "trasa z atestem"); false if it says the course has none ("trasa nie posiada atestu"); null if certification is not mentioned. distances_km: the distances the atest covers when the document names them, else [].${extraFields.length ? '\n5. ADDITIONAL FACTUAL FIELDS — extract directly from the PDF where stated; null if not present.' : ''}

Return ONLY valid JSON, no other text:
{
  "distances_km": [numbers, e.g. 5, 10, 21.1, 42.2],
  "time_based_distances": ["4h", "6h", "12h"],
  "meter_distances": ["200m", "500m"],
  "event_type": ["one or more from the list below"],
  "is_kids": true/false/null,
  "atest": { "certified": true/false/null, "distances_km": [numbers] }${extraFields.length ? ',\n' + extraBlock : ''}
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

function callClaudeWithFile(prompt, filePath) {
  const promptFile = join(tmpdir(), `enrich-prompt-${Date.now()}.txt`)

  try {
    writeFileSync(promptFile, prompt, 'utf-8')
    // --setting-sources "" + --strict-mcp-config + cwd=tmpdir() isolate the subprocess
    // from the interactive Claude Code setup (hooks, plugins, MCP servers, repo
    // CLAUDE.md). Without this, a Stop hook replaces the final message — so
    // response.result is the hook's answer, not the extraction JSON — and every row
    // is skipped. Isolation drops settings-based permission allowlists too, hence
    // the explicit --allowedTools for reading the regulamin file.
    const raw = execSync(
      `cat "${promptFile}" | claude -p --setting-sources "" --strict-mcp-config --allowedTools "Read" --model haiku --output-format json "${filePath}"`,
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, cwd: tmpdir() }
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
      // Canonical form: metres with a space, e.g. "200m" → "200 m" (matches run-normalize.js)
      const mm = String(m).match(/^(\d+)\s*m$/i)
      if (mm) parts.push(`${mm[1]} m`)
    }
  }

  return parts.length > 0 ? parts.join(', ') : null
}

async function main() {
  if (!checkClaudeCli()) {
    console.error('Claude CLI not available. Install: https://docs.anthropic.com/en/docs/claude-cli')
    process.exit(1)
  }

  console.log(`Scope: ${scope.description}${scope.limit ? `, at most ${scope.limit}` : ''}`)
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    let query = supabase
      .from('scraper_all')
      .select('id, source, source_id, name, date, location, voivodeship, distances, event_type, event_types, regulamin_url, regulamin_urls, price_from, price_to, registration_deadline, is_kids, atest_claim, enriched_regulamin_at')
      .not('regulamin_url', 'is', null)
      // Soonest race first, so a run cut short by --limit or by a person has
      // done the most urgent rows.
      .order('date', { ascending: true })
    if (scope.unminedOnly) query = query.is('enriched_regulamin_at', null)
    if (scope.only) {
      query = query.or(
        scope.only.map((r) => `and(source.eq.${r.source},source_id.eq.${r.source_id})`).join(',')
      )
    }
    if (scope.minDate) query = query.gte('date', scope.minDate)
    if (scope.mergedSince) query = query.gte('merged_at', scope.mergedSince)
    const { data, error: fetchErr } = await query.range(from, from + pageSize - 1)

    if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1) }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    if (scope.limit && allRows.length >= scope.limit) break
    from += pageSize
  }
  if (scope.limit) allRows.length = Math.min(allRows.length, scope.limit)

  // Process all rows — even with types set, PDF is authoritative for verification/correction.
  const needsEnrichment = allRows

  console.log(`Found ${allRows.length} rows with regulamin URLs, ${needsEnrichment.length} need PDF verification`)
  let enriched = 0, skipped = 0, failed = 0, rejected = 0
  const rejectedRows = []

  let processed = 0
  for (const row of needsEnrichment) {
    processed++
    const url = row.regulamin_url
    console.log(`\n  [${processed}/${needsEnrichment.length}] ${row.name}`)
    console.log(`    URL: ${url}`)
    console.log(`    current distances: ${row.distances || '(none)'}`)
    console.log(`    current types: ${row.event_types?.join(', ') || '(none)'}`)

    let download = await acquireRegulamin(url, row)
    if (download.error) {
      console.log(`    SKIP: ${download.error}`)
      skipped++
      continue
    }
    let filePath = download.path
    if (download.resolvedUrl) {
      console.log(`    wrapper page, following its link to ${download.resolvedUrl}`)
    }
    console.log(`    acquired: ${download.kind} (${filePath})`)

    // Identity gate — is this document actually this race's regulamin?
    // 'unknown' (a scan, a link-hub PDF) is NOT a rejection: we could not read
    // it, which is not the same as knowing it is wrong. Only a positive
    // 'not-regulamin' stops the run, because feeding the LLM the wrong document
    // is worse than leaving the fields empty — asked for a fee in a document
    // that has none, it invents one (the 0–500 zł ranges in scraper_all).
    let identity = download.identity
    if (identity?.verdict === 'not-regulamin') {
      console.log(`    REJECT: not a regulamin — ${identity.reason}`)
      try { unlinkSync(filePath) } catch {}
      const found = await huntRegulamin({ row, fetchDoc, skip: [url, download.resolvedUrl].filter(Boolean) })
      const replacement = found ? await acquireRegulamin(found.url, row, { followWrapper: false }) : null
      if (replacement && !replacement.error && replacement.identity?.verdict === 'regulamin') {
        console.log(`    FOUND the regulamin via ${found.via}: ${found.url}`)
        // Stored now, not with the extraction: a model call that comes back
        // empty must not leave the rejected URL behind.
        const { error: swapErr } = await supabase
          .from('scraper_all')
          .update({ regulamin_url: found.url })
          .eq('id', row.id)
        console.log(swapErr ? `    ERR storing: ${swapErr.message}` : `    ✓ regulamin_url: ${url} → ${found.url}`)
        download = { ...replacement, resolvedUrl: found.url }
        filePath = download.path
        identity = download.identity
      } else {
        if (replacement?.path) { try { unlinkSync(replacement.path) } catch {} }
        rejected++
        rejectedRows.push({ id: row.id, name: row.name, url, reason: identity.reason })
        const { error: nullErr } = await supabase
          .from('scraper_all')
          .update({ regulamin_url: null })
          .eq('id', row.id)
        console.log(nullErr ? `    ERR nulling: ${nullErr.message}` : '    ✓ regulamin_url nulled (no regulamin found near it)')
        continue
      }
    }
    if (identity?.verdict === 'unknown') {
      console.log(`    NOTE: ${identity.reason} — enriching anyway`)
    }

    try {
      const prompt = buildPrompt(row)
      const extracted = callClaudeWithFile(prompt, filePath)

      if (!extracted) {
        console.log('    SKIP: Claude returned no data')
        failed++
        continue
      }

      const updates = {}
      console.log(`    Claude returned: ${JSON.stringify(extracted)}`)

      // The document we read is the regulamin; the wrapper page only points at
      // it. Storing the document keeps the field meaning one thing, lets
      // run-data-audit read the edition year out of the filename, and spares
      // the next run the hop.
      if (download.resolvedUrl) updates.regulamin_url = download.resolvedUrl

      // Evidence gate — drop any value the document cannot support. A model
      // asked for a fee in a fee-less document answers something rather than
      // null; this is what turned a consent form into "0–500 zł". Skipped when
      // the document had no extractable text (a scan), since absence of
      // evidence there proves nothing.
      if (download.text && download.text.trim().length > 0) {
        const droppedFields = dropUnsupportedFields(extracted, download.text)
        if (droppedFields.length > 0) {
          console.log(`    DROP (unsupported by document): ${droppedFields.join(', ')}`)
        }
        // A regulamin that says "bez opłaty startowej" states the fee: it is 0.
        // The model reads "no number" as "not stated" and answers null, which
        // published herkules:4279 with an empty price.
        fillFreeEntryPrices(extracted, download.text, row)
        if (extracted.price_from === 0) console.log('    FREE: document states no entry fee — price 0')
      }

      // Distances. Claude's extraction REPLACES existing (the regulamin is
      // authoritative), EXCEPT when it only removes distances the scraper found.
      // See dropsDistances(): that means a stale edition's document, not a fix.
      const newDistStr = buildDistancesString(extracted)
      if (newDistStr) {
        if (dropsDistances(row.distances, newDistStr)) {
          console.log(`    WARN: regulamin drops distances (${row.distances} → ${newDistStr}). Keeping the scraper's, the document looks stale`)
        } else if (newDistStr !== (row.distances || '')) {
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

      // is_kids: PDF is authoritative — bidirectional (can set true OR false)
      if (extracted.is_kids === true || extracted.is_kids === false) {
        const current = row.is_kids ?? null
        if (extracted.is_kids !== current) {
          updates.is_kids = extracted.is_kids
        }
      }

      // atest: what THIS edition's regulamin says about course certification.
      // Read by run-atest.js, which publishes an atest only where the PZLA
      // register backs it. Written only when the document said yes or no.
      if (extracted.atest && typeof extracted.atest === 'object' && typeof extracted.atest.certified === 'boolean') {
        const claim = {
          certified: extracted.atest.certified,
          distances_km: Array.isArray(extracted.atest.distances_km)
            ? extracted.atest.distances_km.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : [],
        }
        if (JSON.stringify(claim) !== JSON.stringify(row.atest_claim ?? null)) updates.atest_claim = claim
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
          if (updates.regulamin_url) console.log(`    ✓ regulamin_url: ${url} → ${updates.regulamin_url}`)
          if (updates.distances) console.log(`    ✓ distances: ${row.distances || '(none)'} → ${updates.distances}`)
          if (updates.event_types) console.log(`    ✓ types: ${row.event_types?.join(', ') || '(none)'} → ${updates.event_types.join(', ')}`)
          if (updates.is_kids !== undefined) console.log(`    ✓ is_kids: ${row.is_kids ?? '(none)'} → ${updates.is_kids}`)
          if (updates.atest_claim) console.log(`    ✓ atest_claim: ${JSON.stringify(row.atest_claim ?? null)} → ${JSON.stringify(updates.atest_claim)}`)
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
      try { unlinkSync(filePath) } catch {}
    }

    await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`\n\nDone: ${enriched} enriched, ${skipped} skipped, ${failed} failed, ${rejected} rejected`)
  if (rejectedRows.length > 0) {
    console.log(`\n  Rejected and cleared — the linked document is not this race's regulamin, and none was found near it:`)
    for (const r of rejectedRows) {
      console.log(`    ${r.name}\n      ${r.url}\n      ${r.reason}`)
    }
  }
  console.log(`  total cost: $${totalCostUsd.toFixed(4)}`)
  console.log(`  total tokens: ${totalInputTokens} in / ${totalOutputTokens} out`)
}

main().catch(console.error)
