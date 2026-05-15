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

async function fetchCompetition(competitionId) {
  try {
    const res = await fetch(`${API_URL}/competitions/${competitionId}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.competition || null
  } catch {
    return null
  }
}

async function fetchClassifications(competitionId) {
  try {
    const res = await fetch(`${API_URL}/competitions/${competitionId}/classifications`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return []
    const json = await res.json()
    return json.classifications || []
  } catch {
    return []
  }
}

function parseClassifications(classifications, eventName) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    return { distances: '', isKids: false, priceFrom: null, priceTo: null, latestEndedTime: null }
  }

  // Detect kids run: playerType=kids, or name/classification contains kids keywords
  const kidsKeywords = /dzieci|młodzie[żz]|junior|kid/i
  const allKids = classifications.every(c =>
    c.classificationSetting?.playerType === 'kids' || kidsKeywords.test(c.namePl || '')
  )
  const isKids = allKids || kidsKeywords.test(eventName)

  const seen = new Set()
  const parts = []

  // Aggregate price tiers and registration deadline across classifications.
  // Skip kids classifications in mixed events for both distance AND price aggregation —
  // a kids 100m at 20 PLN would dominate price_from for an adults marathon at 100 PLN.
  const adultPrices = []
  let latestEndedTime = null

  for (const c of classifications) {
    const name = (c.namePl || '').trim()
    const isKidsClassification =
      c.classificationSetting?.playerType === 'kids' || kidsKeywords.test(name)

    if (!isKids && isKidsClassification) {
      continue
    }

    // Price tiers: { price: "259.00", endedTime: "2026-05-31T..." }
    const tiers = Array.isArray(c.classificationPrices) ? c.classificationPrices : []
    for (const t of tiers) {
      const n = Number(t.price)
      if (Number.isFinite(n) && n >= 0) adultPrices.push(n)
      if (t.endedTime && (!latestEndedTime || t.endedTime > latestEndedTime)) {
        latestEndedTime = t.endedTime
      }
    }

    // 1. API distance field (km)
    if (c.distance && c.distance > 0) {
      const label = `${c.distance} km`
      if (!seen.has(label)) { parts.push(label); seen.add(label) }
      continue
    }

    // 2. Time-based: "4 H", "6H", "12h", backyard
    const hourMatch = name.match(/\b(\d{1,2})\s*[hH]\b/)
    if (hourMatch) {
      const label = `${parseInt(hourMatch[1])}h`
      if (!seen.has(label)) { parts.push(label); seen.add(label) }
      continue
    }
    if (/backyard/i.test(name)) {
      if (!seen.has('backyard')) { parts.push('backyard'); seen.add('backyard') }
      continue
    }

    // 3. Meter distances from name: "100m", "800m", "1200m"
    const meterMatch = name.match(/\b(\d{2,5})\s*m\b/i)
    if (meterMatch) {
      const m = parseInt(meterMatch[1])
      const label = m >= 1000 ? `${(m / 1000).toFixed(1).replace(/\.0$/, '')} km` : `${m}m`
      if (!seen.has(label)) { parts.push(label); seen.add(label) }
      continue
    }

    // 4. Named distances: mila, półmaraton, maraton, cooper
    if (/\bmila\b/i.test(name)) {
      if (!seen.has('1 mila')) { parts.push('1 mila'); seen.add('1 mila') }
    } else if (/półmaraton|polmaraton/i.test(name)) {
      if (!seen.has('21.1 km')) { parts.push('21.1 km'); seen.add('21.1 km') }
    } else if (/\bmaraton\b/i.test(name) && !/pół/i.test(name)) {
      if (!seen.has('42.2 km')) { parts.push('42.2 km'); seen.add('42.2 km') }
    } else if (/cooper/i.test(name)) {
      if (!seen.has('test coopera')) { parts.push('test coopera'); seen.add('test coopera') }
    }
  }

  return {
    distances: parts.join(', '),
    isKids,
    priceFrom: adultPrices.length > 0 ? Math.min(...adultPrices) : null,
    priceTo: adultPrices.length > 0 ? Math.max(...adultPrices) : null,
    latestEndedTime,
  }
}

function makeUrl(permaLink, id) {
  if (permaLink) return `https://dostartu.pl${permaLink}`
  return `https://dostartu.pl/permalink-v${id}`
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

    // Fetch distances + prices + deadline from classifications
    const classifications = await fetchClassifications(ev.id)
    const { distances, isKids, priceFrom, priceTo, latestEndedTime } =
      parseClassifications(classifications, ev.name)

    const location = ev.location || null
    const sourceUrl = makeUrl(ev.permaLink, ev.id)
    // dostartu permalink IS the canonical registration target. Even when
    // ev.websitePl is set, that's the organizer's info site (often static,
    // sometimes a Facebook page) — registrations still happen on dostartu.
    // ev.websitePl belongs in `website`, not `registration_url`.
    const eventType = TYPE_MAP[ev.type] || null
    // Prefer external link (real PDF) over dostartu-hosted (often SPA shell)
    const regulaminUrl = ev.statuteLinkPl || ev.statuteFilePl || null

    // Registration deadline source preference (ev.endDate is null for ~95% of races):
    //   1. max(classificationPrices.endedTime) — the last paid tier closes registration
    //   2. competition.provisionTime — explicit registration close date
    //   3. competition.endDate — legacy field, almost always null
    const deadlineIso = latestEndedTime || ev.provisionTime || ev.endDate
    const registrationDeadline = deadlineIso ? deadlineIso.split('T')[0] : null

    results.push({
      name: ev.name,
      date,
      registration_deadline: registrationDeadline,
      location,
      distances,
      registration_url: sourceUrl,
      regulamin_url: regulaminUrl,
      website: ev.websitePl || null,
      source: 'dostartu',
      source_url: sourceUrl,
      source_id: String(ev.id),
      lat: ev.locationLat || null,
      lng: ev.locationLng || null,
      event_type: eventType,
      is_kids: isKids,
      price_from: priceFrom,
      price_to: priceTo,
    })

    console.log(`[dostartu] Detail pages: ${i + 1}/${newEvents.length} — ${ev.name}`)

    // Rate limit
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`[dostartu] Scraped ${results.length} events with details`)
  return results
}

export { scrape, fetchCompetition, fetchClassifications, parseClassifications }
