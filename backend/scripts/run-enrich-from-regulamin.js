import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AI_FILLABLE, pickFillable, fieldsNeedingFill, applyRegistryUpdates } from './lib/ai-fillable.js'

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
// - distances: Claude's extraction REPLACES scraper distances (regulamin is authoritative)
// - event_types: Claude's types are MERGED with existing (additive only)
//
// Host-only: relies on the `claude` CLI plus macOS `textutil` (docx/html) and
// `pdftotext` — none are in the backend Docker image (same constraint as step 8).

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

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

const FETCH_HEADERS = { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' }

function tmpPath(ext) {
  return join(tmpdir(), `regulamin-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`)
}

async function fetchBuffer(url) {
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType }
  } catch (err) {
    return { error: err.message?.slice(0, 100) || 'unknown' }
  }
}

// Identify what we downloaded from magic bytes first, then content-type / URL hints.
// Returns 'pdf' | 'docx' | 'html' | 'unknown'.
function detectKind(buffer, contentType, url) {
  const ascii = buffer.slice(0, 8).toString('latin1')
  if (ascii.startsWith('%PDF')) return 'pdf'
  if (ascii.startsWith('PK')) {
    // Office Open XML (.docx) is a zip — confirm via name, content-type, or a `word/` entry
    if (/\.docx(\?|$)/i.test(url) || contentType.includes('wordprocessingml')) return 'docx'
    if (buffer.toString('latin1', 0, Math.min(buffer.length, 4000)).includes('word/')) return 'docx'
    return 'unknown'
  }
  if (contentType.includes('pdf') || /\.pdf(\?|$)/i.test(url)) return 'pdf'
  if (contentType.includes('wordprocessingml') || /\.docx(\?|$)/i.test(url)) return 'docx'
  const head = buffer.slice(0, 200).toString('utf-8').trim().toLowerCase()
  if (contentType.includes('html') || head.startsWith('<!doctype') || head.startsWith('<html')) return 'html'
  return 'unknown'
}

// Extract plain text from a downloaded buffer with the right local tool:
// pdf -> pdftotext, docx/html -> textutil (macOS). Returns text or null.
function extractText(buffer, kind) {
  const f = tmpPath(kind === 'pdf' ? 'pdf' : kind === 'docx' ? 'docx' : 'html')
  try {
    writeFileSync(f, buffer)
    const cmd = kind === 'pdf'
      ? `pdftotext -enc UTF-8 "${f}" -`
      : `textutil -convert txt -stdout "${f}"`
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return null
  } finally {
    try { unlinkSync(f) } catch {}
  }
}

const driveFolderId = (url) => (url.match(/\/drive\/folders\/([0-9A-Za-z_-]+)/) || [])[1] || null
const driveFileId = (url) =>
  (url.match(/\/file\/d\/([0-9A-Za-z_-]+)/) || [])[1] ||
  (url.match(/[?&]id=([0-9A-Za-z_-]+)/) || [])[1] || null
const driveDownloadUrl = (id) => `https://drive.google.com/uc?export=download&id=${id}`

// Parse a public Drive folder page for the file ids it lists (rendered as data-id="...").
async function listDriveFolder(url) {
  const res = await fetchBuffer(url)
  if (res.error) return res
  const html = res.buffer.toString('utf-8')
  const ids = [...new Set([...html.matchAll(/data-id="(1[0-9A-Za-z_-]{25,44})"/g)].map((m) => m[1]))]
  if (ids.length === 0) return { error: 'no files in folder (private or empty?)' }
  return { ids }
}

// Download a regulamin from any supported URL and return a local file ready for Claude:
// { path, kind } where kind 'pdf' is read natively by Claude (best table fidelity) and
// 'text' is a .txt we extracted ourselves (docx, html page, or multi-file Drive folder).
async function acquireRegulamin(url) {
  // 1) Google Drive folder -> download every file, extract text, concatenate
  const folderId = driveFolderId(url)
  if (folderId) {
    const folder = await listDriveFolder(url)
    if (folder.error) return folder
    const chunks = []
    for (const id of folder.ids) {
      const dl = await fetchBuffer(driveDownloadUrl(id))
      if (dl.error) continue
      const kind = detectKind(dl.buffer, dl.contentType, '')
      if (kind !== 'pdf' && kind !== 'docx') continue // skip images / unknown / interstitials
      const text = extractText(dl.buffer, kind)
      if (text && text.trim().length > 50) chunks.push(`=== ${id} (${kind}) ===\n${text.trim()}`)
    }
    if (chunks.length === 0) return { error: 'Drive folder had no extractable documents' }
    const f = tmpPath('txt')
    writeFileSync(f, chunks.join('\n\n'), 'utf-8')
    return { path: f, kind: 'text' }
  }

  // 2) Single file (Drive file link gets rewritten to its direct-download URL)
  const fileId = driveFileId(url)
  const dl = await fetchBuffer(fileId ? driveDownloadUrl(fileId) : url)
  if (dl.error) return dl
  if (dl.buffer.length < 500) return { error: `too small (${dl.buffer.length} bytes)` }

  const kind = detectKind(dl.buffer, dl.contentType, url)
  // A Drive file that comes back as HTML is the virus-scan interstitial, not a document
  if (fileId && kind === 'html') return { error: 'Drive interstitial (not a direct document)' }
  if (kind === 'unknown') return { error: `unsupported type (${dl.contentType || 'no content-type'})` }

  if (kind === 'pdf') {
    const f = tmpPath('pdf')
    writeFileSync(f, dl.buffer)
    return { path: f, kind: 'pdf' }
  }

  const text = extractText(dl.buffer, kind)
  if (!text || text.trim().length < 50) return { error: `${kind} extraction empty` }
  const f = tmpPath('txt')
  writeFileSync(f, text.trim(), 'utf-8')
  return { path: f, kind: 'text' }
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
3. IS_KIDS — does this regulamin include a dedicated children's/youth race? true if yes (biegi dla dzieci, separate category for kids/youth under 18, "mini bieg"); false if the regulamin clearly covers only adult/open-age races; null if not mentioned.${extraFields.length ? '\n4. ADDITIONAL FACTUAL FIELDS — extract directly from the PDF where stated; null if not present.' : ''}

Return ONLY valid JSON, no other text:
{
  "distances_km": [numbers, e.g. 5, 10, 21.1, 42.2],
  "time_based_distances": ["4h", "6h", "12h"],
  "meter_distances": ["200m", "500m"],
  "event_type": ["one or more from the list below"],
  "is_kids": true/false/null${extraFields.length ? ',\n' + extraBlock : ''}
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
    const raw = execSync(
      `cat "${promptFile}" | claude -p --model haiku --output-format json "${filePath}"`,
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

  // Process all rows — even with types set, PDF is authoritative for verification/correction.
  const needsEnrichment = allRows

  console.log(`Found ${allRows.length} rows with regulamin URLs, ${needsEnrichment.length} need PDF verification`)
  let enriched = 0, skipped = 0, failed = 0

  let processed = 0
  for (const row of needsEnrichment) {
    processed++
    const url = row.regulamin_url
    console.log(`\n  [${processed}/${needsEnrichment.length}] ${row.name}`)
    console.log(`    URL: ${url}`)
    console.log(`    current distances: ${row.distances || '(none)'}`)
    console.log(`    current types: ${row.event_types?.join(', ') || '(none)'}`)

    const download = await acquireRegulamin(url)
    if (download.error) {
      console.log(`    SKIP: ${download.error}`)
      skipped++
      continue
    }
    const filePath = download.path
    console.log(`    acquired: ${download.kind} (${filePath})`)

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

      // is_kids: PDF is authoritative — bidirectional (can set true OR false)
      if (extracted.is_kids === true || extracted.is_kids === false) {
        const current = row.is_kids ?? null
        if (extracted.is_kids !== current) {
          updates.is_kids = extracted.is_kids
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
          if (updates.is_kids !== undefined) console.log(`    ✓ is_kids: ${row.is_kids ?? '(none)'} → ${updates.is_kids}`)
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

  console.log(`\n\nDone: ${enriched} enriched, ${skipped} skipped, ${failed} failed`)
  console.log(`  total cost: $${totalCostUsd.toFixed(4)}`)
  console.log(`  total tokens: ${totalInputTokens} in / ${totalOutputTokens} out`)
}

main().catch(console.error)
