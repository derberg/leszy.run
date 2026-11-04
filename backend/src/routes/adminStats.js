import { supabase } from '../lib/supabaseClient.js'
import { buildAdminStats } from '../lib/adminStats.js'

// PostgREST caps a response at 1000 rows, so every table is read in pages.
async function fetchAll(table, columns) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

export async function adminStatsRoutes(fastify) {
  // Growth figures per Warsaw month (sign-ups, clubs, stars, registrations,
  // payments) plus current totals, for the admin "Statystyki" page.
  fastify.get('/admin/stats', async (request, reply) => {
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })
    const months = Math.min(Math.max(Number(request.query.months) || 12, 1), 36)
    try {
      const [profiles, clubs, clubMembers, favorites, registrationEvents, registrations, orders, refunds] = await Promise.all([
        fetchAll('profiles', 'created_at, username, deleted_at'),
        fetchAll('clubs', 'created_at'),
        fetchAll('club_members', 'joined_at, status, role'),
        fetchAll('event_favorites', 'created_at'),
        fetchAll('registration_settings', 'published_at, state'),
        fetchAll('registrations', 'created_at, status'),
        fetchAll('orders', 'id, paid_at, total'),
        fetchAll('refunds', 'order_id, amount, dpay_status, responded_at, created_at'),
      ])
      const stats = buildAdminStats(
        { profiles, clubs, clubMembers, favorites, registrationEvents, registrations, orders, refunds },
        { months },
      )
      return { data: stats }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })
}
