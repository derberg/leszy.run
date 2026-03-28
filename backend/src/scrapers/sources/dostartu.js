const API_URL = 'https://api.dostartu.pl'

// Only running-related event types
const RUNNING_TYPES = [1, 6, 16, 21] // running, mountain_running, ocr, nordic_walking

const TYPE_MAP = {
  1: 'bieg',
  6: 'trail',
  16: 'ocr',
  21: 'nordic-walking',
}

async function fetchPage(page, dateSince) {
  const params = new URLSearchParams({
    dateSince,
    itemsPerPage: '100',
    page: String(page),
  })
  for (const t of RUNNING_TYPES) {
    params.append('types[]', String(t))
  }

  const res = await fetch(`${API_URL}/competitions?${params}`, {
    headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
  })
  if (!res.ok) throw new Error(`dostartu API ${res.status}`)
  const json = await res.json()
  return json.competitions || []
}

async function fetchClassifications(competitionId) {
  try {
    const res = await fetch(`${API_URL}/competitions/${competitionId}/classifications`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

function makeUrl(id) {
  return `https://dostartu.pl/front_start.php?vid=${id}`
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []
  const dateSince = new Date().toISOString()

  // Paginate through all future running events
  let page = 1
  let allEvents = []
  while (true) {
    const items = await fetchPage(page, dateSince)
    if (!items || items.length === 0) break
    allEvents = allEvents.concat(items)
    console.log(`[dostartu] Page ${page}: ${items.length} events`)
    if (items.length < 100) break
    page++
    await new Promise(r => setTimeout(r, 500))
  }

  const newEvents = allEvents.filter(ev => !knownIds.has(String(ev.id)))
  console.log(`[dostartu] Found ${allEvents.length} events, ${newEvents.length} new (skipping ${allEvents.length - newEvents.length} known)`)

  for (let i = 0; i < newEvents.length; i++) {
    const ev = newEvents[i]

    const date = ev.startedTime ? ev.startedTime.split('T')[0] : null
    if (!date) continue

    // Fetch distances from classifications
    const classifications = await fetchClassifications(ev.id)
    const distances = (Array.isArray(classifications) ? classifications : [])
      .filter(c => c.distance && c.distance > 0)
      .map(c => `${c.distance} km`)
      .filter((d, idx, arr) => arr.indexOf(d) === idx)

    const location = ev.location || null
    const url = ev.websitePl || makeUrl(ev.id)
    const eventType = TYPE_MAP[ev.type] || null

    results.push({
      name: ev.name,
      date,
      end_date: ev.endDate ? ev.endDate.split('T')[0] : null,
      location,
      distances: distances.join(', '),
      registration_url: url,
      source: 'dostartu',
      source_url: makeUrl(ev.id),
      source_id: String(ev.id),
      lat: ev.locationLat || null,
      lng: ev.locationLng || null,
      event_type: eventType,
    })

    // Rate limit
    await new Promise(r => setTimeout(r, 500))

    if ((i + 1) % 50 === 0) {
      console.log(`[dostartu] Classifications: ${i + 1}/${allEvents.length}`)
    }
  }

  console.log(`[dostartu] Scraped ${results.length} events with details`)
  return results
}

export { scrape }
