import { supabase } from '../lib/supabaseClient.js'
import { logAdminAction } from '../lib/adminAudit.js'

export async function urlSuggestionsRoutes(fastify) {
  fastify.get('/url-suggestions', async (request, reply) => {
    const { status = 'pending' } = request.query

    const { data, error } = await supabase
      .from('url_suggestions')
      .select(`
        *,
        calendar_events!inner(id, name, date, location)
      `)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) return reply.status(500).send({ error: error.message })
    return { data }
  })

  fastify.post('/url-suggestions/:id/approve', async (request, reply) => {
    const { id } = request.params

    const { data: suggestion, error: fetchErr } = await supabase
      .from('url_suggestions')
      .select('calendar_event_id, url')
      .eq('id', id)
      .single()

    if (fetchErr) return reply.status(404).send({ error: 'Suggestion not found' })

    await logAdminAction({ action: 'approve_url_suggestion', targetTable: 'url_suggestions', targetId: id, payload: { url: suggestion.url, calendar_event_id: suggestion.calendar_event_id }, req: request.raw })

    await supabase
      .from('url_suggestions')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', id)

    await supabase
      .from('url_suggestions')
      .update({ status: 'rejected', rejection_reason: 'other_approved', reviewed_at: new Date().toISOString() })
      .eq('calendar_event_id', suggestion.calendar_event_id)
      .neq('id', id)
      .eq('status', 'pending')

    await supabase
      .from('calendar_events')
      .update({ registration_url: suggestion.url, updated_at: new Date().toISOString() })
      .eq('id', suggestion.calendar_event_id)

    return { data: { approved: true } }
  })

  fastify.post('/url-suggestions/:id/reject', async (request, reply) => {
    const { id } = request.params
    const { reason } = request.body || {}
    await logAdminAction({ action: 'reject_url_suggestion', targetTable: 'url_suggestions', targetId: id, payload: { reason }, req: request.raw })

    const { error } = await supabase
      .from('url_suggestions')
      .update({
        status: 'rejected',
        rejection_reason: reason || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (error) return reply.status(400).send({ error: error.message })
    return { data: { rejected: true } }
  })
}
