import { supabase } from '../lib/supabaseClient.js'

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'

async function searchBrave(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) return []

  try {
    const params = new URLSearchParams({ q: query, count: '3' })
    const res = await fetch(`${BRAVE_API_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    })

    const data = await res.json()
    return (data.web?.results || []).slice(0, 3).map((r, i) => ({
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
    return { processed: 0, suggestions: 0 }
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
    return { processed: 0, suggestions: 0 }
  }

  let totalSuggestions = 0

  for (const event of events) {
    const { count } = await supabase
      .from('url_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('calendar_event_id', event.id)
      .eq('status', 'pending')

    if (count > 0) continue

    const year = new Date(event.date).getFullYear()
    const query = `${event.name} ${year} zapisy rejestracja ${event.location || ''}`
    const results = await searchBrave(query)

    if (results.length > 0) {
      const suggestions = results.map(r => ({
        calendar_event_id: event.id,
        search_query: query,
        search_engine: 'brave',
        rank: r.rank,
        url: r.url,
        page_title: r.page_title,
        snippet: r.snippet,
      }))

      await supabase.from('url_suggestions').insert(suggestions)
      totalSuggestions += suggestions.length
    }

    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[urlResolver] Processed ${events.length} events, created ${totalSuggestions} suggestions`)
  return { processed: events.length, suggestions: totalSuggestions }
}

export { resolveUrls }
