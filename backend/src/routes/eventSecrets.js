import { createClient } from '@supabase/supabase-js'
import { eq } from 'drizzle-orm'
import { events } from '../db/schema.js'
import { pullCheckins } from '../sync/checkinSync.js'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function generatePin() { return String(Math.floor(100000 + Math.random() * 900000)) }

export async function eventSecretsRoutes(fastify) {
  const { db } = fastify

  fastify.get('/events/:eventId/secrets/checkin-pin', async (req, reply) => {
    const supabase = getSupabase()
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })
    const { data, error } = await supabase.from('event_secrets').select('checkin_pin').eq('event_id', req.params.eventId).single()
    if (error && error.code !== 'PGRST116') return reply.code(500).send({ error: error.message })
    return { data: { checkinPin: data?.checkin_pin || null } }
  })

  fastify.post('/events/:eventId/secrets/checkin-pin', async (req, reply) => {
    const supabase = getSupabase()
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })
    const event = await db.query.events.findFirst({ where: eq(events.id, req.params.eventId) })
    if (!event) return reply.code(404).send({ error: 'Event not found' })
    const pin = generatePin()
    const { error } = await supabase.from('event_secrets').upsert({ event_id: req.params.eventId, checkin_pin: pin }, { onConflict: 'event_id' })
    if (error) return reply.code(500).send({ error: error.message })
    return { data: { checkinPin: pin } }
  })

  fastify.post('/events/:eventId/sync/checkins', async (req, reply) => {
    await pullCheckins(db)
    return { data: { synced: true } }
  })
}
