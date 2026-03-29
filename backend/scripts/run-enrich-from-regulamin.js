import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Usage: cd backend && node --env-file=../.env scripts/run-enrich-from-regulamin.js
// Finds scraper_all entries missing distances or event type that have a regulamin URL,
// fetches the PDF, and uses local Claude to extract distances and event type.
//
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const VALID_EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic', 'ultra', 'charytatywny', 'uliczny', 'bieg']

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
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('pdf') && !url.toLowerCase().endsWith('.pdf')) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 500) return null // too small to be a real PDF

    writeFileSync(tmpFile, buffer)
    return tmpFile
  } catch {
    return null
  }
}

function buildPrompt(event) {
  return `You are extracting structured data about a Polish running/walking race event from its official regulations (regulamin) PDF.

Event name: ${event.name}
Event date: ${event.date}
Event location: ${event.location || 'unknown'}

Look at the attached PDF and extract:
1. Race distances — look for "trasa", "dystans", "długość trasy", classification names, or distance mentions
2. Event type classification

Return ONLY valid JSON, no other text:
{
  "distances_km": [numbers, e.g. 5, 10, 21.1, 42.2],
  "time_based_distances": ["4h", "6h", "12h"],
  "meter_distances": ["200m", "500m"],
  "event_type": ["trail", "nocny", "ocr", "nordic", "ultra", "charytatywny", "uliczny"]
}

Rules:
- Only include actual race distances, not age limits, elevation, or other numbers
- półmaraton = 21.1, maraton = 42.2
- time_based_distances for timed ultras (e.g. "bieg 6-godzinny" → "6h")
- meter_distances for short distances under 1 km (e.g. biegi dzieci 200m, 500m)
- event_type: only use values from the list above, leave empty array if just a regular road race
- trail = przełaj, terenowy, górski, leśny; nocny = night race; ocr = obstacle; nordic = nordic walking; ultra = ultramaraton or distances > 42.2 km; charytatywny = charity; uliczny = road/city
- If information is not found, use empty array []`
}

function callClaudeWithPdf(prompt, pdfPath) {
  const promptFile = join(tmpdir(), `enrich-prompt-${Date.now()}.txt`)

  try {
    writeFileSync(promptFile, prompt, 'utf-8')
    const result = execSync(
      `cat "${promptFile}" | claude -p --model haiku --output-format text "${pdfPath}"`,
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 }
    )

    // Strip markdown code fences if present, then find JSON
    const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '')
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      return JSON.parse(match[0])
    }
    console.log(`    Claude raw output: ${result.slice(0, 200)}`)
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

  // Fetch all rows that have a regulamin URL, then filter in JS
  // (Supabase .or() with compound conditions is unreliable)
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error: fetchErr } = await supabase
      .from('scraper_all')
      .select('id, name, date, location, distances, event_type, event_types, regulamin_url, regulamin_urls')
      .not('regulamin_url', 'is', null)
      .range(from, from + pageSize - 1)

    if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1) }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Found ${allRows.length} rows to enrich`)
  let enriched = 0, skipped = 0, failed = 0

  for (const row of allRows) {
    const url = row.regulamin_url
    console.log(`\n  ${row.name}`)
    console.log(`    URL: ${url}`)

    // Download PDF
    const pdfPath = await downloadPdf(url)
    if (!pdfPath) {
      console.log('    SKIP: could not download PDF')
      skipped++
      continue
    }

    try {
      // Call Claude with PDF
      const prompt = buildPrompt(row)
      const extracted = callClaudeWithPdf(prompt, pdfPath)

      if (!extracted) {
        console.log('    SKIP: Claude returned no data')
        failed++
        continue
      }

      const updates = {}

      // Distances — always merge (Claude may find distances the scraper missed)
      const newDistStr = buildDistancesString(extracted)
      if (newDistStr) {
        const existing = new Set((row.distances || '').split(',').map(s => s.trim()).filter(Boolean))
        const incoming = newDistStr.split(',').map(s => s.trim())
        for (const d of incoming) existing.add(d)
        const merged = [...existing].join(', ')
        if (merged !== (row.distances || '')) {
          updates.distances = merged
        }
      }

      // Event type — always try to fill
      if (extracted.event_type && Array.isArray(extracted.event_type)) {
        const valid = extracted.event_type.filter(t => VALID_EVENT_TYPES.includes(t))
        if (valid.length > 0) {
          const existingTypes = row.event_types || []
          const merged = [...new Set([...existingTypes, ...valid])]
          if (merged.length > existingTypes.length) {
            updates.event_types = merged
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        const { error: updateErr } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
        if (updateErr) {
          console.log(`    ERR: ${updateErr.message}`)
          failed++
        } else {
          const fields = Object.entries(updates).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
          console.log(`    OK: ${fields}`)
          enriched++
        }
      } else {
        console.log('    SKIP: nothing extracted')
        skipped++
      }
    } finally {
      try { unlinkSync(pdfPath) } catch {}
    }

    // Small delay between Claude calls
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`\n\nDone: ${enriched} enriched, ${skipped} skipped, ${failed} failed`)
}

main().catch(console.error)
