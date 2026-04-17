import { supabase } from '../lib/supabaseClient.js'
import { jaccardSimilarity, citiesMatch } from '../scrapers/dedup.js'

function capitalizeVoivodeship(s) {
  if (!s) return s
  return s.replace(/(^|-)(\S)/g, (_, sep, ch) => sep + ch.toUpperCase())
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
        .select('id, name, date, location, voivodeship, source, source_id, registration_url, regulamin_url, registration_deadline, source_url, event_type, distances, price_from, price_to, lat, lng')
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

    // Fetch dismissed pairs
    const { data: dismissed } = await supabase
      .from('dismissed_duplicates')
      .select('event_id_1, event_id_2')
    const dismissedSet = new Set(
      (dismissed || []).flatMap(d => [
        `${d.event_id_1}:${d.event_id_2}`,
        `${d.event_id_2}:${d.event_id_1}`,
      ])
    )

    // Remove dismissed pairs from union-find by re-building without them
    // Reset parent
    for (const e of allEvents) parent[e.id] = e.id

    for (const events of Object.values(byDate)) {
      if (events.length < 2) continue
      for (let i = 0; i < events.length; i++) {
        for (let j = i + 1; j < events.length; j++) {
          const a = events[i], b = events[j]
          if (dismissedSet.has(`${a.id}:${b.id}`)) continue

          const locMatch = citiesMatch(a.location, b.location)
          if (!locMatch) continue
          const sim = jaccardSimilarity(a.name, b.name)
          if (sim > 0.35) { union(a.id, b.id); continue }
        }
      }
    }

    // Build clusters
    const filteredClusters = {}
    for (const e of allEvents) {
      const root = find(e.id)
      if (!filteredClusters[root]) filteredClusters[root] = []
      filteredClusters[root].push(e)
    }

    // Return only clusters with 2+ events
    const groups = Object.values(filteredClusters)
      .filter(g => g.length > 1)
      .sort((a, b) => a[0].date.localeCompare(b[0].date))

    return { data: groups }
  })

  // Dismiss a group as not-duplicates (stores all pairs)
  fastify.post('/calendar-events/dismiss-duplicates', async (request, reply) => {
    const { eventIds } = request.body
    if (!eventIds || eventIds.length < 2) {
      return reply.status(400).send({ error: 'Need at least 2 event IDs' })
    }

    const pairs = []
    for (let i = 0; i < eventIds.length; i++) {
      for (let j = i + 1; j < eventIds.length; j++) {
        const [a, b] = eventIds[i] < eventIds[j] ? [eventIds[i], eventIds[j]] : [eventIds[j], eventIds[i]]
        pairs.push({ event_id_1: a, event_id_2: b })
      }
    }

    const { error } = await supabase
      .from('dismissed_duplicates')
      .upsert(pairs, { onConflict: 'event_id_1,event_id_2' })

    if (error) return reply.status(500).send({ error: error.message })
    return { dismissed: pairs.length }
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

    query = query.gte('date', new Date().toISOString().split('T')[0])

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

  fastify.patch('/calendar-events/:id/reject', async (request, reply) => {
    const { id } = request.params
    const { data, error } = await supabase
      .from('calendar_events')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  fastify.post('/calendar-events', async (request, reply) => {
    const event = { ...request.body, source: 'manual', status: 'active' }
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
    // Soft-delete: set status to 'rejected' instead of removing the row.
    // Hard delete loses the source+source_id pair, so run-publish.js
    // re-creates the event on next run. Rejected rows are kept to prevent that.
    const { error } = await supabase
      .from('calendar_events')
      .update({ status: 'rejected' })
      .eq('id', id)

    if (error) return reply.status(400).send({ error: error.message })
    return { success: true }
  })
}
