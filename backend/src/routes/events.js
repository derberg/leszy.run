import { eq, sql } from 'drizzle-orm'
import { events, categories, participants, raceRuns } from '../db/schema.js'
import { syncDeleteEvent } from '../sync/supabase.js'

export async function eventsRoutes(fastify) {
  const { db } = fastify

  // List all events with counts
  fastify.get('/events', async () => {
    const rows = await db
      .select({
        event: events,
        categoryCount: sql`(select count(*) from categories where event_id = events.id)`.as('category_count'),
        participantCount: sql`(select count(*) from participants where event_id = events.id)`.as('participant_count'),
      })
      .from(events)
      .orderBy(events.createdAt)

    return { data: rows }
  })

  // Get single event
  fastify.get('/events/:id', async (req, reply) => {
    const row = await db.query.events.findFirst({ where: eq(events.id, req.params.id) })
    if (!row) return reply.code(404).send({ error: 'Event not found' })
    return { data: row }
  })

  // Create event
  fastify.post('/events', async (req, reply) => {
    const { name, description, date, location, eventUrl } = req.body
    if (!name) return reply.code(400).send({ error: 'name is required' })

    const slug = name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    const [row] = await db.insert(events).values({ name, description, date, location, eventUrl, slug }).returning()
    return reply.code(201).send({ data: row })
  })

  // Update event (includes RFID settings)
  fastify.patch('/events/:id', async (req, reply) => {
    const allowed = ['name', 'description', 'date', 'location', 'rfidMode', 'rfidTopicMain', 'rfidTopicFinish', 'rssiThreshold', 'confirmRssiCdbm', 'declineThresholdCdbm', 'fallbackSeconds', 'gunBackfillSeconds', 'gunBackfillEnabled', 'minFinishSeconds', 'slug', 'publicResultsUrl', 'eventUrl', 'visibility']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    if (updates.slug !== undefined) {
      updates.slug = updates.slug.toLowerCase().replace(/[^a-z0-9-]/g, '')
      if (!updates.slug) return reply.code(400).send({ error: 'Invalid slug' })
    }
    if (Object.keys(updates).length === 0) return reply.code(400).send({ error: 'No fields to update' })

    const [row] = await db.update(events).set(updates).where(eq(events.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Event not found' })
    return { data: row }
  })

  // Delete event
  fastify.delete('/events/:id', async (req, reply) => {
    const [row] = await db.delete(events).where(eq(events.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Event not found' })
    syncDeleteEvent(row.id)
    return { data: row }
  })
}
