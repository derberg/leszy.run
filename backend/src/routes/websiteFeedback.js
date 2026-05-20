import { supabase } from '../lib/supabaseClient.js'

export async function websiteFeedbackRoutes(fastify) {
  fastify.get('/website-feedback', async (request, reply) => {
    const { status = 'pending', category } = request.query

    let query = supabase
      .from('website_feedback')
      .select('*, profiles!website_feedback_user_id_fkey(id, username, display_name, email)')
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (category) {
      query = query.eq('category', category)
    }

    const { data, error } = await query

    if (error) return reply.status(500).send({ error: error.message })
    return { data }
  })

  fastify.patch('/website-feedback/:id/review', async (request, reply) => {
    const { id } = request.params
    const { admin_note } = request.body || {}

    const updates = {
      status: 'reviewed',
      reviewed_at: new Date().toISOString(),
    }
    if (admin_note !== undefined) updates.admin_note = admin_note

    const { error } = await supabase
      .from('website_feedback')
      .update(updates)
      .eq('id', id)

    if (error) return reply.status(500).send({ error: error.message })
    return { success: true }
  })

  fastify.patch('/website-feedback/:id/dismiss', async (request, reply) => {
    const { id } = request.params
    const { admin_note } = request.body || {}

    const updates = {
      status: 'dismissed',
      reviewed_at: new Date().toISOString(),
    }
    if (admin_note !== undefined) updates.admin_note = admin_note

    const { error } = await supabase
      .from('website_feedback')
      .update(updates)
      .eq('id', id)

    if (error) return reply.status(500).send({ error: error.message })
    return { success: true }
  })
}
