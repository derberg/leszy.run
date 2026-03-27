import { supabase } from '../lib/supabaseClient.js'

function capitalizeVoivodeship(s) {
  if (!s) return s
  return s.replace(/(^|-)(\S)/g, (_, sep, ch) => sep + ch.toUpperCase())
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

function nameSimilarity(a, b) {
  const normA = a.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').trim()
  const normB = b.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').trim()
  const maxLen = Math.max(normA.length, normB.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(normA, normB) / maxLen
}

export async function calendarEventsRoutes(fastify) {
  // Duplicate detection endpoint
  fastify.get('/calendar-events/duplicates', async (request, reply) => {
    // Fetch all active future events
    let allEvents = []
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data, error } = await supabase
        .from('calendar_events')
        .select('id, name, date, location, voivodeship, source, source_id, registration_url, source_url, event_type, distances, price_from, price_to, lat, lng, is_night, is_charity')
        .eq('status', 'active')
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date')
        .range(from, from + PAGE - 1)
      if (error) return reply.status(500).send({ error: error.message })
      allEvents = allEvents.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    // Group by date
    const byDate = {}
    for (const e of allEvents) {
      if (!byDate[e.date]) byDate[e.date] = []
      byDate[e.date].push(e)
    }

    // Union-Find to cluster duplicates
    const parent = {}
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
    const union = (a, b) => { parent[find(a)] = find(b) }

    for (const e of allEvents) parent[e.id] = e.id

    // Find duplicate pairs within each date group
    for (const events of Object.values(byDate)) {
      if (events.length < 2) continue
      for (let i = 0; i < events.length; i++) {
        for (let j = i + 1; j < events.length; j++) {
          const a = events[i], b = events[j]
          const sim = nameSimilarity(a.name, b.name)
          if (sim < 0.70) continue

          // Check location similarity — if both have locations and they differ a lot, skip
          if (a.location && b.location) {
            const locSim = nameSimilarity(a.location, b.location)
            if (locSim < 0.50) continue
          }

          union(a.id, b.id)
        }
      }
    }

    // Build clusters
    const clusters = {}
    for (const e of allEvents) {
      const root = find(e.id)
      if (!clusters[root]) clusters[root] = []
      clusters[root].push(e)
    }

    // Return only clusters with 2+ events
    const groups = Object.values(clusters)
      .filter(g => g.length > 1)
      .sort((a, b) => a[0].date.localeCompare(b[0].date))

    return { data: groups }
  })

  fastify.get('/calendar-events', async (request, reply) => {
    const { page = 1, limit = 200, source, filter, status = 'active' } = request.query
    const from = (page - 1) * limit

    let query = supabase
      .from('calendar_events')
      .select('*', { count: 'exact' })
      .eq('status', status)
      .order('date', { ascending: true })
      .range(from, from + limit - 1)

    if (status === 'active') {
      query = query.gte('date', new Date().toISOString().split('T')[0])
    }

    if (source) query = query.eq('source', source)

    const { data, count, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { data, total: count }
  })

  fastify.patch('/calendar-events/:id/approve', async (request, reply) => {
    const { id } = request.params
    const { data, error } = await supabase
      .from('calendar_events')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  fastify.post('/calendar-events', async (request, reply) => {
    const event = { ...request.body, source: 'manual' }
    if (event.voivodeship) event.voivodeship = capitalizeVoivodeship(event.voivodeship)
    const { data, error } = await supabase
      .from('calendar_events')
      .insert(event)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  fastify.patch('/calendar-events/:id', async (request, reply) => {
    const { id } = request.params
    const updates = { ...request.body, updated_at: new Date().toISOString() }
    if (updates.voivodeship) updates.voivodeship = capitalizeVoivodeship(updates.voivodeship)

    const { data, error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  fastify.delete('/calendar-events/:id', async (request, reply) => {
    const { id } = request.params
    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('id', id)

    if (error) return reply.status(400).send({ error: error.message })
    return { success: true }
  })
}
