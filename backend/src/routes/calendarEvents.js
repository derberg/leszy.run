import { supabase } from '../lib/supabaseClient.js'

export async function calendarEventsRoutes(fastify) {
  fastify.get('/calendar-events', async (request, reply) => {
    const { page = 1, limit = 50, source } = request.query
    const from = (page - 1) * limit

    let query = supabase
      .from('calendar_events')
      .select('*', { count: 'exact' })
      .order('date', { ascending: true })
      .range(from, from + limit - 1)

    if (source) query = query.eq('source', source)

    const { data, count, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { data, total: count }
  })

  fastify.post('/calendar-events', async (request, reply) => {
    const event = { ...request.body, source: 'manual' }
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
