import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { voivodeshipFromText } from '../src/scrapers/postalCodeMapper.js'

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

  // Try up to 3 search results — use the best for distances, check ALL for voivodeship
  let bestContext = null
  let bestTitle = null
  let bestKmCount = -1
  let detectedVoivodeship = null
  const allTexts = []

  for (const result of results) {
    const pageText = await fetchPageText(result.url)
    const text = pageText || `${result.title} ${result.description || ''}`
    allTexts.push(text)

    // Score for distance quality
    const kmCount = (text.match(/\d+[\.,]?\d*\s*km/gi) || []).length
      + (text.match(/kilometr/gi) || []).length
      + (text.match(/\d{2}-\d{3}/g) || []).length
      + (text.match(/dystans|trasa|długość/gi) || []).length

    console.log(`  [${kmCount}] ${result.title.slice(0, 60)}`)

    if (kmCount > bestKmCount) {
      bestKmCount = kmCount
      bestContext = text
      bestTitle = result.title
    }

    // Check every page for voivodeship (postal code or name)
    if (!detectedVoivodeship) {
      detectedVoivodeship = voivodeshipFromText(text)
    }

    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`  Best: ${bestTitle?.slice(0, 60)} (score: ${bestKmCount})`)

  const context = bestContext
  if (detectedVoivodeship) {
    console.log(`  Voivodeship from page: ${detectedVoivodeship}`)
  }

  const prompt = `Extract ALL available running/walking race distances OR time formats from this event.
Return a JSON array of strings like ["5 km", "10 km", "21.1 km"] for distance-based events.
For time-based events (e.g. 24h relay, 12h run, 30 min), return ["24h"] or ["12h"] or ["30 min"].
Common Polish: półmaraton = "21.1 km", maraton = "42.2 km", piątka = "5 km", dziesiątka = "10 km".
Include ALL distances/categories. Return ONLY the JSON array, nothing else.
If truly nothing can be determined, return [].

Event name: ${event.name}
Date: ${event.date}
Location: ${event.location || 'unknown'}

Page content:
${context.slice(0, 3000)}`

  const result = callClaude(prompt)
  let distances = null

  if (result) {
    const match = result.match(/\[.*?\]/s)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed) && parsed.length > 0) {
          distances = parsed.filter(d => typeof d === 'string' || (typeof d === 'number' && d > 0))
        }
      } catch {}
    }
  }

  return { distances, voivodeship: detectedVoivodeship }
}

// Main — process events missing distances OR voivodeship
const { data: events } = await supabase
  .from('calendar_events')
  .select('id, name, date, location, voivodeship, source')
  .eq('status', 'active')
  .gte('date', new Date().toISOString().split('T')[0])
  .or('distances_meters.is.null,distances_meters.eq.{},voivodeship.is.null')
  .order('date')
  .limit(BATCH_SIZE)

console.log(`Processing ${events.length} events missing distances or voivodeship...\n`)

let enrichedDist = 0
let enrichedVoi = 0
for (const event of events) {
  console.log(`[${enrichedDist + enrichedVoi}/${events.length}] ${event.name} (${event.location || '?'})`)

  const result = await enrichEvent(event)

  const updates = {}

  if (result?.distances) {
    const distanceStrings = result.distances.map(d => typeof d === 'number' ? `${d} km` : String(d))
    const distanceMeters = result.distances
      .map(d => {
        if (typeof d === 'number') return Math.round(d * 1000)
        const kmMatch = String(d).match(/^([\d.]+)\s*km$/i)
        return kmMatch ? Math.round(parseFloat(kmMatch[1]) * 1000) : null
      })
      .filter(Boolean)

    updates.distances = distanceStrings
    updates.distances_meters = distanceMeters.length > 0 ? distanceMeters : null
    console.log(`  ✓ Distances: [${distanceStrings.join(', ')}]`)
    enrichedDist++
  }

  if (result?.voivodeship && !event.voivodeship) {
    updates.voivodeship = result.voivodeship
    console.log(`  ✓ Voivodeship: ${result.voivodeship}`)
    enrichedVoi++
  }

  if (Object.keys(updates).length > 0) {
    await supabase.from('calendar_events').update(updates).eq('id', event.id)
  } else {
    console.log(`  ✗ No new data found`)
  }

  // Rate limit: Brave (1 req/sec) + Claude (~4s) + page fetch
  await new Promise(r => setTimeout(r, 1000))
}

console.log(`\nDone. Distances: ${enrichedDist}, Voivodeships: ${enrichedVoi} (out of ${events.length} events)`)
