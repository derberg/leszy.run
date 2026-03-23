import { supabase } from '../lib/supabaseClient.js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function callClaude(name, description) {
  const prompt = `Extract running/walking race distances from this event description.
Return ONLY a valid JSON array of distances in km (numbers only), like [5, 10, 21.1, 42.2].
If the event is a half marathon (półmaraton), include 21.1.
If the event is a marathon (maraton), include 42.2.
If no distances can be determined, return [].
Do NOT include any other text, only the JSON array.

Event name: ${name || ''}
Description: ${(description || '').slice(0, 3000)}`

  const tmpFile = join(tmpdir(), `llm-enrich-${Date.now()}.txt`)

  try {
    writeFileSync(tmpFile, prompt, 'utf-8')
    const result = execSync(
      `cat "${tmpFile}" | claude -p --model haiku --output-format text`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 }
    )

    const match = result.match(/\[[\d.,\s]*\]/)
    if (match) {
      const distances = JSON.parse(match[0])
      if (Array.isArray(distances) && distances.every(d => typeof d === 'number')) {
        return distances
      }
    }
  } catch (err) {
    console.error(`[llmEnricher] Claude call failed for "${name}":`, err.message?.slice(0, 100))
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
  return null
}

async function enrichDistances() {
  if (!supabase) {
    console.log('[llmEnricher] Supabase not configured, skipping')
    return { processed: 0, enriched: 0 }
  }

  // Find events missing distances (use raw_description, description, or just name)
  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, raw_description, description, distances, distances_meters')
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(500)

  if (!events?.length) {
    console.log('[llmEnricher] No events found')
    return { processed: 0, enriched: 0 }
  }

  const needsEnrichment = events.filter(e =>
    !e.distances_meters || e.distances_meters.length === 0
  )

  const batch = needsEnrichment.slice(0, 50)
  console.log(`[llmEnricher] Processing ${batch.length} events (${needsEnrichment.length} total need enrichment)...`)
  let enriched = 0

  for (const event of batch) {
    const desc = event.raw_description || event.description || ''
    console.log(`[llmEnricher] Calling Claude for: ${event.name}`)
    const distances = callClaude(event.name, desc)

    if (distances && distances.length > 0) {
      const distanceStrings = distances.map(d => `${d} km`)
      const distanceMeters = distances.map(d => Math.round(d * 1000))

      const { error } = await supabase
        .from('calendar_events')
        .update({
          distances: distanceStrings,
          distances_meters: distanceMeters,
        })
        .eq('id', event.id)

      if (!error) {
        console.log(`  ${event.name} → [${distanceStrings.join(', ')}]`)
        enriched++
      }
    }

    // Delay between Claude CLI calls to avoid process buildup
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`[llmEnricher] Enriched ${enriched}/${needsEnrichment.length} events`)
  return { processed: needsEnrichment.length, enriched }
}

export { enrichDistances }
