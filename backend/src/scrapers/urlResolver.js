import { supabase } from '../lib/supabaseClient.js'

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'

const AGGREGATOR_DOMAINS = [
  'maratonypolskie.pl',
  'liveds.datasport.pl',
  'datasport.pl',
  'biegiwpolsce.pl',
  'elektronicznezapisy.pl',
  'bieganie.pl',
  'kalendarzbiegowy.pl',
]

function isAggregatorUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return AGGREGATOR_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

async function searchBrave(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) return []

  try {
    const params = new URLSearchParams({ q: query, count: '5' })
    const res = await fetch(`${BRAVE_API_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    })

    const data = await res.json()
    return (data.web?.results || []).map((r, i) => ({
      rank: i + 1,
      url: r.url,
      page_title: r.title,
      snippet: r.description,
    }))
  } catch (err) {
    console.error(`Brave search failed for "${query}":`, err.message)
    return []
  }
}

async function resolveUrls() {
  if (!process.env.BRAVE_SEARCH_API_KEY || !supabase) {
    console.log('[urlResolver] BRAVE_SEARCH_API_KEY not set or Supabase not configured, skipping')
    return { processed: 0, assigned: 0 }
  }

  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, date, location')
    .is('registration_url', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(50)

  if (!events?.length) {
    console.log('[urlResolver] No events need URL resolution')
    return { processed: 0, assigned: 0 }
  }

  let assigned = 0

  for (const event of events) {
    const year = new Date(event.date).getFullYear()
    const query = `${event.name} ${year} zapisy rejestracja ${event.location || ''}`
    const results = await searchBrave(query)

    // Filter out aggregator domains
    const filtered = results.filter(r => !isAggregatorUrl(r.url))
    const bestUrl = filtered.length > 0 ? filtered[0].url : null

    // Save all results as audit trail
    if (results.length > 0) {
      const suggestions = results.map(r => ({
        calendar_event_id: event.id,
        search_query: query,
        search_engine: 'brave',
        rank: r.rank,
        url: r.url,
        page_title: r.page_title,
        snippet: r.snippet,
        status: (bestUrl && r.url === bestUrl) ? 'auto_assigned' : 'alternative',
      }))

      await supabase.from('url_suggestions').insert(suggestions)
    }

    // Auto-assign best non-aggregator URL
    if (bestUrl) {
      const { error } = await supabase
        .from('calendar_events')
        .update({ registration_url: bestUrl })
        .eq('id', event.id)

      if (!error) {
        console.log(`[urlResolver] ${event.name} → ${bestUrl}`)
        assigned++
      }
    }

    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[urlResolver] Processed ${events.length} events, assigned ${assigned} URLs`)
  return { processed: events.length, assigned }
}

export { resolveUrls }
