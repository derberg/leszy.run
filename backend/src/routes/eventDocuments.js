import { eq } from 'drizzle-orm'
import { eventDocuments } from '../db/schema.js'

export async function eventDocumentsRoutes(fastify) {
  const { db } = fastify

  fastify.get('/events/:eventId/documents', async (req) => {
    const rows = await db.query.eventDocuments.findMany({
      where: eq(eventDocuments.eventId, req.params.eventId),
      orderBy: eventDocuments.sortOrder,
    })
    return { data: rows }
  })

  fastify.post('/events/:eventId/documents', async (req, reply) => {
    const { name, type, url, requiredFor, sortOrder } = req.body
    if (!name || !type) return reply.code(400).send({ error: 'name and type are required' })
    if (!['acknowledge', 'provide'].includes(type)) return reply.code(400).send({ error: 'type must be acknowledge or provide' })
    const [row] = await db.insert(eventDocuments).values({
      eventId: req.params.eventId, name, type, url: url || null, requiredFor: requiredFor || 'all', sortOrder: sortOrder || 0,
    }).returning()
    return reply.code(201).send({ data: row })
  })

  fastify.patch('/documents/:id', async (req, reply) => {
    const allowed = ['name', 'type', 'url', 'requiredFor', 'sortOrder']
    const updates = {}
    for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key] }
    updates.updatedAt = new Date()
    if (Object.keys(updates).length <= 1) return reply.code(400).send({ error: 'No fields to update' })
    const [row] = await db.update(eventDocuments).set(updates).where(eq(eventDocuments.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Document not found' })
    return { data: row }
  })

  fastify.delete('/documents/:id', async (req, reply) => {
    const [row] = await db.delete(eventDocuments).where(eq(eventDocuments.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Document not found' })
    return { data: row }
  })
}
