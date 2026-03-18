import { eq, and, isNull, sql, max } from 'drizzle-orm'
import { participants, categories, results, raceRuns } from '../db/schema.js'
import { setScanMode } from '../mqtt/client.js'
import Papa from 'papaparse'
import { pickEmoji } from '../lib/emoji.js'
import { syncDelete } from '../sync/supabase.js'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

export async function participantsRoutes(fastify) {
  const { db } = fastify

  // List participants for event (with category info)
  fastify.get('/events/:eventId/participants', async (req) => {
    const rows = await db.query.participants.findMany({
      where: eq(participants.eventId, req.params.eventId),
      with: { category: true, checkin: true },
      orderBy: participants.bibNumber,
    })
    return { data: rows }
  })

  // Create participant
  fastify.post('/events/:eventId/participants', async (req, reply) => {
    const { firstName, lastName, email, gender, birthDate, club, categoryId } = req.body
    if (!firstName || !lastName) return reply.code(400).send({ error: 'firstName and lastName are required' })

    const [nextBib, existingEmojis] = await Promise.all([
      nextBibNumber(db, req.params.eventId),
      usedEmojis(db, req.params.eventId),
    ])
    const emoji = pickEmoji(existingEmojis)

    const [row] = await db.insert(participants).values({
      eventId: req.params.eventId,
      firstName, lastName, email, gender, birthDate, club,
      categoryId: categoryId || null,
      bibNumber: nextBib,
      emoji,
    }).returning()

    return reply.code(201).send({ data: row })
  })

  // Update participant (inline edit)
  fastify.patch('/participants/:id', async (req, reply) => {
    const allowed = ['firstName', 'lastName', 'email', 'gender', 'birthDate', 'club', 'bibNumber', 'categoryId', 'rfidEpc', 'phone']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key] === '' ? null : req.body[key]
    }
    updates.updatedAt = new Date()
    if (Object.keys(updates).length === 0) return reply.code(400).send({ error: 'No fields to update' })

    try {
      const [row] = await db.update(participants).set(updates).where(eq(participants.id, req.params.id)).returning()
      if (!row) return reply.code(404).send({ error: 'Participant not found' })
      return { data: row }
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'Bib number or RFID already taken' })
      throw err
    }
  })

  // Delete participant
  fastify.delete('/participants/:id', async (req, reply) => {
    const [row] = await db.delete(participants).where(eq(participants.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Participant not found' })
    syncDelete('participants', row.id)
    return { data: row }
  })

  // Import participants from CSV
  fastify.post('/events/:eventId/import/participants', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })

    const buf = await data.toBuffer()
    const { data: rows, errors } = Papa.parse(buf.toString('utf-8'), { header: true, skipEmptyLines: true })
    if (errors.length) return reply.code(400).send({ error: 'CSV parse error', details: errors })

    // Build slug→id map for categories
    const cats = await db.query.categories.findMany({
      where: eq(categories.eventId, req.params.eventId),
    })
    const catMap = new Map(cats.map(c => [c.slug, c.id]))

    const existingEmojis = await usedEmojis(db, req.params.eventId)
    const assignedInThisImport = []

    let imported = 0, updated = 0, skipped = 0
    const importErrors = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row.first_name || !row.last_name) {
        importErrors.push({ row: i + 2, message: 'Missing required fields: first_name, last_name' })
        skipped++
        continue
      }

      let categoryId = null
      if (row.category_id) {
        const slug = String(row.category_id).toLowerCase().replace(/\s+/g, '-')
        categoryId = catMap.get(slug) || null
        if (!categoryId) {
          importErrors.push({ row: i + 2, message: `Unknown category_id: ${row.category_id}` })
        }
      }

      const rawPhone = row.phone || row.telefon || row.tel || null
      let phone = rawPhone ? rawPhone.replace(/[\s()-]/g, '').replace(/^(?!\+)48/, '+48').replace(/^(?!\+)/, '+48') : null
      if (phone && !/^\+\d{9,15}$/.test(phone)) {
        importErrors.push({ row: i + 2, message: `Invalid phone format: ${rawPhone}` })
        phone = null
      }

      const existing = row.email
        ? await db.query.participants.findFirst({
            where: and(eq(participants.eventId, req.params.eventId), eq(participants.email, row.email)),
          })
        : null

      if (existing) {
        await db.update(participants).set({
          firstName: row.first_name,
          lastName: row.last_name,
          gender: row.gender || existing.gender,
          birthDate: row.birth_date || (row.birth_year ? `${row.birth_year}-01-01` : existing.birthDate),
          club: row.club || existing.club,
          categoryId: categoryId || existing.categoryId,
          phone: phone || existing.phone,
        }).where(eq(participants.id, existing.id))
        updated++
      } else {
        const nextBib = await nextBibNumber(db, req.params.eventId)
        const emoji = pickEmoji([...existingEmojis, ...assignedInThisImport])
        assignedInThisImport.push(emoji)
        await db.insert(participants).values({
          eventId: req.params.eventId,
          firstName: row.first_name,
          lastName: row.last_name,
          email: row.email || null,
          gender: row.gender || null,
          birthDate: row.birth_date || (row.birth_year ? `${row.birth_year}-01-01` : null),
          club: row.club || null,
          categoryId,
          bibNumber: nextBib,
          emoji,
          phone: phone || null,
        })
        imported++
      }
    }

    return { data: { imported, updated, skipped, errors: importErrors } }
  })

  // Admin check-in (writes to Supabase, reverse sync pulls to local)
  fastify.post('/participants/:id/checkin', async (req, reply) => {
    const { documents } = req.body || {}
    const participant = await db.query.participants.findFirst({
      where: eq(participants.id, req.params.id),
    })
    if (!participant) return reply.code(404).send({ error: 'Participant not found' })

    const supabase = getSupabase()
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })

    const { data: checkin, error: checkinError } = await supabase
      .from('checkins')
      .upsert({
        participant_id: participant.id,
        event_id: participant.eventId,
        checked_in_at: new Date().toISOString(),
      }, { onConflict: 'participant_id' })
      .select()
      .single()

    if (checkinError) return reply.code(500).send({ error: checkinError.message })

    if (documents?.length) {
      const docRows = documents.map(d => ({
        checkin_id: checkin.id,
        document_id: d.documentId,
        completed_at: new Date().toISOString(),
        completed_by: d.completedBy || 'admin',
      }))
      await supabase.from('checkin_documents').upsert(docRows, { onConflict: 'checkin_id,document_id' })
    }

    return { data: checkin }
  })

  // RFID scan mode — start
  fastify.post('/rfid/scan-mode/start', async () => {
    setScanMode(true)
    return { data: { active: true } }
  })

  // RFID scan mode — stop
  fastify.post('/rfid/scan-mode/stop', async () => {
    setScanMode(false)
    return { data: { active: false } }
  })
}

async function nextBibNumber(db, eventId) {
  const [row] = await db
    .select({ max: sql`COALESCE(MAX(bib_number), 0)` })
    .from(participants)
    .where(eq(participants.eventId, eventId))
  return Number(row.max) + 1
}

async function usedEmojis(db, eventId) {
  const rows = await db
    .select({ emoji: participants.emoji })
    .from(participants)
    .where(eq(participants.eventId, eventId))
  return rows.map(r => r.emoji).filter(Boolean)
}
