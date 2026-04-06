import { eq, and, sql } from 'drizzle-orm'
import { categories, events } from '../db/schema.js'
import { syncDelete } from '../sync/supabase.js'
import Papa from 'papaparse'

export async function categoriesRoutes(fastify) {
  const { db } = fastify

  // List categories for event
  fastify.get('/events/:eventId/categories', async (req, reply) => {
    const rows = await db
      .select({
        category: categories,
        participantCount: sql`(select count(*) from participants where category_id = categories.id)`.as('participant_count'),
      })
      .from(categories)
      .where(eq(categories.eventId, req.params.eventId))
      .orderBy(categories.name)

    return { data: rows }
  })

  // Create category
  fastify.post('/events/:eventId/categories', async (req, reply) => {
    const { name, slug } = req.body
    if (!name || !slug) return reply.code(400).send({ error: 'name and slug are required' })

    const [row] = await db.insert(categories).values({
      eventId: req.params.eventId,
      name,
      slug: slug.toLowerCase().replace(/\s+/g, '-'),
    }).returning()

    return reply.code(201).send({ data: row })
  })

  // Update category
  fastify.patch('/categories/:id', async (req, reply) => {
    const allowed = ['name', 'slug']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    const [row] = await db.update(categories).set(updates).where(eq(categories.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Category not found' })
    return { data: row }
  })

  // Delete category
  fastify.delete('/categories/:id', async (req, reply) => {
    const [row] = await db.delete(categories).where(eq(categories.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Category not found' })
    syncDelete('categories', row.id)
    return { data: row }
  })

  // Import categories from CSV
  fastify.post('/events/:eventId/import/categories', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })

    const buf = await data.toBuffer()
    const csv = buf.toString('utf-8')
    const { data: rows, errors } = Papa.parse(csv, { header: true, skipEmptyLines: true })

    if (errors.length) return reply.code(400).send({ error: 'CSV parse error', details: errors })

    let imported = 0, updated = 0, skipped = 0
    const importErrors = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row.id || !row.name) {
        importErrors.push({ row: i + 2, message: 'Missing required fields: id, name' })
        skipped++
        continue
      }

      const slug = String(row.id).toLowerCase().replace(/\s+/g, '-')
      const existing = await db.query.categories.findFirst({
        where: and(eq(categories.eventId, req.params.eventId), eq(categories.slug, slug)),
      })

      if (existing) {
        await db.update(categories).set({
          name: row.name,
        }).where(eq(categories.id, existing.id))
        updated++
      } else {
        await db.insert(categories).values({
          eventId: req.params.eventId,
          name: row.name,
          slug,
        })
        imported++
      }
    }

    return { data: { imported, updated, skipped, errors: importErrors } }
  })
}
