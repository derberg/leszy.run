import { supabase } from '../lib/supabaseClient.js'
import { execSync } from 'child_process'

const PROMPT = `Extract running/walking race distances from this event description.
Return ONLY a valid JSON array of distances in km (numbers only), like [5, 10, 21.1, 42.2].
If the event is a half marathon (półmaraton), include 21.1.
If the event is a marathon (maraton), include 42.2.
If no distances can be determined, return [].
Do NOT include any other text, only the JSON array.

Event name: {name}
Description: {description}`

function callClaude(name, description) {
  const prompt = PROMPT
    .replace('{name}', name || '')
    .replace('{description}', (description || '').slice(0, 3000))

  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --model haiku --output-format text`,
      { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    )

    // Extract JSON array from response (might be wrapped in ```json blocks)
    const match = result.match(/\[[\d.,\s]*\]/)
    if (match) {
      const distances = JSON.parse(match[0])
      if (Array.isArray(distances) && distances.every(d => typeof d === 'number')) {
        return distances
      }
    }
  } catch (err) {
    console.error(`[llmEnricher] Claude call failed for "${name}":`, err.message?.slice(0, 100))
  }
  return null
}

async function enrichDistances() {
  if (!supabase) {
    console.log('[llmEnricher] Supabase not configured, skipping')
    return { processed: 0, enriched: 0 }
  }

  // Find events with raw_description but no distances
  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, raw_description, distances, distances_meters')
    .not('raw_description', 'is', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .or('distances.is.null,distances.eq.{}')
    .limit(50) // Process in batches

  if (!events?.length) {
    console.log('[llmEnricher] No events need distance enrichment')
    return { processed: 0, enriched: 0 }
  }

  // Also include events where distances_meters is empty
  const needsEnrichment = events.filter(e =>
    !e.distances_meters || e.distances_meters.length === 0
  )

  console.log(`[llmEnricher] Processing ${needsEnrichment.length} events...`)
  let enriched = 0

  for (const event of needsEnrichment) {
    const distances = callClaude(event.name, event.raw_description)

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

    // Small delay between calls
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`[llmEnricher] Enriched ${enriched}/${needsEnrichment.length} events`)
  return { processed: needsEnrichment.length, enriched }
}

export { enrichDistances }
