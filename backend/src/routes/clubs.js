import { supabase } from '../lib/supabaseClient.js'
import { logAdminAction } from '../lib/adminAudit.js'

export async function clubsRoutes(fastify) {
  // List all clubs with member counts + similarity-grouped duplicate suggestions
  fastify.get('/clubs', async (request, reply) => {
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })
    const [clubsRes, pairsRes] = await Promise.all([
      supabase.from('clubs').select('id, name, created_at, profiles(count)').order('name'),
      supabase.rpc('similar_club_pairs', { threshold: 0.45 }),
    ])
    if (clubsRes.error) return reply.status(500).send({ error: clubsRes.error.message })
    if (pairsRes.error) return reply.status(500).send({ error: pairsRes.error.message })

    const data = clubsRes.data.map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      memberCount: c.profiles?.[0]?.count ?? 0,
    }))
    return { data, duplicates: pairsRes.data ?? [] }
  })

  // Merge source clubs into target: repoints profiles.club_id, deletes sources. Atomic.
  fastify.post('/clubs/:id/merge', async (request, reply) => {
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })
    const { id } = request.params
    const { sourceIds } = request.body || {}
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      return reply.status(400).send({ error: 'sourceIds (non-empty array) required' })
    }
    if (sourceIds.includes(id)) {
      return reply.status(400).send({ error: 'target club cannot be in sourceIds' })
    }
    await logAdminAction({ action: 'merge_clubs', targetTable: 'clubs', targetId: id, payload: { sourceIds }, req: request.raw })
    const { data: moved, error } = await supabase.rpc('merge_clubs', { target: id, sources: sourceIds })
    if (error) {
      const status = /not found|unknown|cannot be/.test(error.message) ? 400 : 500
      return reply.status(status).send({ error: error.message })
    }
    return { data: { movedMembers: moved } }
  })
}
