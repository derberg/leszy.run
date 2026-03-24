import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'
const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY

const BATCH_SIZE = parseInt(process.env.ENRICH_BATCH_SIZE || '20', 10)

async function searchBrave(query) {
  const params = new URLSearchParams({ q: query, count: '3' })
  const res = await fetch(`${BRAVE_API_URL}?${params}`, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY },
  })
  const data = await res.json()
  return (data.web?.results || []).slice(0, 3)
}

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const html = await res.text()
    // Strip HTML tags, keep text
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
  } catch {
    return null
  }
}

function callClaude(prompt) {
  const tmpFile = join(tmpdir(), `enrich-search-${Date.now()}.txt`)
  try {
    writeFileSync(tmpFile, prompt, 'utf-8')
    const result = execSync(
      `cat "${tmpFile}" | claude -p --model haiku --output-format text`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 }
    )
    return result.trim()
  } catch (err) {
    return null
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

async function enrichEvent(event) {
  // Clean query: avoid duplicating year if already in name, don't add noise words
  const year = new Date(event.date).getFullYear()
  const nameHasYear = event.name.includes(String(year))
  const query = `${event.name}${nameHasYear ? '' : ' ' + year} ${event.location || ''}`

  console.log(`\n  Searching: "${query}"`)

  const results = await searchBrave(query)
  if (results.length === 0) {
    console.log(`  No search results`)
    return null
  }

  // Try up to 3 search results — use the one with the most "km" mentions
  let bestContext = null
  let bestUrl = null
  let bestTitle = null
  let bestKmCount = -1

  for (const result of results) {
    const pageText = await fetchPageText(result.url)
    const text = pageText || `${result.title} ${result.description || ''}`
    const kmCount = (text.match(/\d+[\.,]?\d*\s*km/gi) || []).length

    console.log(`  [${kmCount} km] ${result.title.slice(0, 60)}`)

    if (kmCount > bestKmCount) {
      bestKmCount = kmCount
      bestContext = text
      bestUrl = result.url
      bestTitle = result.title
    }

    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`  Best: ${bestTitle?.slice(0, 60)} (${bestKmCount} km mentions)`)

  const context = bestContext

  const prompt = `Extract ALL available running/walking race distances from this event page.
Return ONLY a valid JSON array of distances in km (numbers only), like [5, 10, 21.1, 42.2].
Common Polish distances: półmaraton = 21.1, maraton = 42.2, piątka = 5, dziesiątka = 10.
If the event has multiple distances/categories, include ALL of them.
If you truly cannot determine any distance, return [].

Event name: ${event.name}
Date: ${event.date}
Location: ${event.location || 'unknown'}

Page content:
${context.slice(0, 3000)}`

  const result = callClaude(prompt)
  if (!result) return null

  const match = result.match(/\[[\d.,\s]*\]/)
  if (!match) return null

  try {
    const distances = JSON.parse(match[0])
    if (Array.isArray(distances) && distances.length > 0 && distances.every(d => typeof d === 'number' && d > 0)) {
      return distances
    }
  } catch {}

  return null
}

// Main
const { data: events } = await supabase
  .from('calendar_events')
  .select('id, name, date, location, source')
  .eq('status', 'active')
  .gte('date', new Date().toISOString().split('T')[0])
  .or('distances_meters.is.null,distances_meters.eq.{}')
  .order('date')
  .limit(BATCH_SIZE)

console.log(`Processing ${events.length} events missing distances...\n`)

let enriched = 0
for (const event of events) {
  console.log(`[${enriched}/${events.length}] ${event.name} (${event.location || '?'})`)

  const distances = await enrichEvent(event)

  if (distances) {
    const distanceStrings = distances.map(d => `${d} km`)
    const distanceMeters = distances.map(d => Math.round(d * 1000))

    await supabase.from('calendar_events').update({
      distances: distanceStrings,
      distances_meters: distanceMeters,
    }).eq('id', event.id)

    console.log(`  ✓ Enriched: [${distanceStrings.join(', ')}]`)
    enriched++
  } else {
    console.log(`  ✗ Could not determine distances`)
  }

  // Rate limit: Brave (1 req/sec) + Claude (~4s) + page fetch
  await new Promise(r => setTimeout(r, 1000))
}

console.log(`\nDone. Enriched ${enriched}/${events.length} events`)
