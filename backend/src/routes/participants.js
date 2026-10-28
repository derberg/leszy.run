import { eq, and, isNull, sql, max, ne } from 'drizzle-orm'
import { participants, categories, results, raceRuns, checkins, events } from '../db/schema.js'
import { setScanMode } from '../mqtt/client.js'
import Papa from 'papaparse'
import { pickEmoji } from '../lib/emoji.js'
import { syncDelete } from '../sync/supabase.js'
import { createClient } from '@supabase/supabase-js'
import { withdrawalRefusal } from '../lib/withdrawal.js'
import { isRemoved, isRegistrationEvent, REGISTRATION_DELETE_REFUSAL } from '../lib/registrationGuards.js'
import { checkinParticipantRow } from '../lib/checkinParticipantRow.js'

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
      where: and(eq(participants.eventId, req.params.eventId), isNull(participants.removedAt)),
      with: { category: true, checkin: true },
      orderBy: participants.bibNumber,
    })
    return { data: rows }
  })

  // Create participant
  fastify.post('/events/:eventId/participants', async (req, reply) => {
    const { firstName, lastName, email, phone, gender, birthDate, club, categoryId, tshirtSize } = req.body
    if (!firstName || !lastName) return reply.code(400).send({ error: 'firstName and lastName are required' })

    const [nextBib, existingEmojis] = await Promise.all([
      nextBibNumber(db, req.params.eventId),
      usedEmojis(db, req.params.eventId),
    ])
    const emoji = pickEmoji(existingEmojis)

    const [row] = await db.insert(participants).values({
      eventId: req.params.eventId,
      firstName, lastName, email, phone: phone || null, gender, birthDate, club,
      categoryId: categoryId || null,
      tshirtSize: tshirtSize || null,
      bibNumber: nextBib,
      emoji,
    }).returning()

    return reply.code(201).send({ data: row })
  })

  // Update participant (inline edit)
  fastify.patch('/participants/:id', async (req, reply) => {
    const allowed = ['firstName', 'lastName', 'email', 'gender', 'birthDate', 'club', 'bibNumber', 'categoryId', 'rfidEpc', 'phone', 'tshirtSize']
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

  // The runner came but will not start. Before the gun only; race start seeds their result as DNS.
  fastify.post('/participants/:id/withdraw', (req, reply) => setWithdrawn(req, reply, new Date()))
  fastify.delete('/participants/:id/withdraw', (req, reply) => setWithdrawn(req, reply, null))

  async function setWithdrawn(req, reply, withdrawnAt) {
    const current = await db.query.participants.findFirst({ where: eq(participants.id, req.params.id) })
    if (isRemoved(current)) return reply.code(409).send({ error: 'Zawodnik wycofany z zapisów online.' })
    const refusal = withdrawalRefusal(await liveResultCount(db, req.params.id))
    if (refusal) return reply.code(409).send({ error: refusal })
    const [row] = await db.update(participants).set({ withdrawnAt, updatedAt: new Date() })
      .where(eq(participants.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Participant not found' })
    return { data: row }
  }

  // Regenerate emoji
  fastify.post('/participants/:id/regenerate-emoji', async (req, reply) => {
    const [participant] = await db.select().from(participants).where(eq(participants.id, req.params.id))
    if (!participant) return reply.code(404).send({ error: 'Participant not found' })

    const existing = await usedEmojis(db, participant.eventId)
    let emoji
    let attempts = 0
    // Keep trying until we get a different emoji (max 20 attempts)
    do {
      emoji = pickEmoji(existing)
      attempts++
    } while (emoji === participant.emoji && attempts < 20)
    
    const [row] = await db.update(participants).set({ emoji, updatedAt: new Date() }).where(eq(participants.id, req.params.id)).returning()
    return { data: row }
  })

  // Delete participant
  fastify.delete('/participants/:id', async (req, reply) => {
    const owner = await db.query.participants.findFirst({ where: eq(participants.id, req.params.id), columns: { eventId: true } })
    if (owner) {
      const event = await db.query.events.findFirst({ where: eq(events.id, owner.eventId) })
      if (isRegistrationEvent(event)) return reply.code(409).send({ error: REGISTRATION_DELETE_REFUSAL })
    }
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

    // Get starting bib number once, then increment locally to avoid race condition
    let nextBib = await nextBibNumber(db, req.params.eventId)

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

      // Match by email + name to handle family members with shared emails
      const existing = row.email
        ? await db.query.participants.findFirst({
            where: and(
              eq(participants.eventId, req.params.eventId),
              isNull(participants.removedAt),
              eq(participants.email, row.email),
              eq(participants.firstName, row.first_name),
              eq(participants.lastName, row.last_name)
            ),
          })
        : null

      if (existing) {
        await db.update(participants).set({
          gender: row.gender || existing.gender,
          birthDate: row.birth_date || (row.birth_year ? `${row.birth_year}-01-01` : existing.birthDate),
          club: row.club || existing.club,
          categoryId: categoryId || existing.categoryId,
          phone: phone || existing.phone,
          tshirtSize: row.tshirt_size || existing.tshirtSize,
        }).where(eq(participants.id, existing.id))
        updated++
      } else {
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
          tshirtSize: row.tshirt_size || null,
        })
        imported++
        nextBib++ // Increment for next participant
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

    // Ensure participant exists in Supabase before creating checkin (FK constraint).
    // checkinParticipantRow never sends a Supabase-owned column (registration_id, removed_at).
    const { error: partError } = await supabase.from('participants')
      .upsert(checkinParticipantRow(participant), { onConflict: 'id' })
    if (partError) return reply.code(500).send({ error: `Supabase participant sync failed: ${partError.message}` })

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

    // Mirror to local DB immediately so UI reflects the change without waiting for reverse sync
    await db.insert(checkins).values({
      id: checkin.id,
      participantId: checkin.participant_id,
      eventId: checkin.event_id,
      checkedInAt: checkin.checked_in_at ? new Date(checkin.checked_in_at) : null,
      createdAt: checkin.created_at ? new Date(checkin.created_at) : null,
      updatedAt: checkin.updated_at ? new Date(checkin.updated_at) : null,
      syncedAt: new Date(),
    }).onConflictDoUpdate({
      target: checkins.participantId,
      set: { checkedInAt: checkin.checked_in_at ? new Date(checkin.checked_in_at) : null, updatedAt: new Date(), syncedAt: new Date() },
    })

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

  fastify.delete('/participants/:id/checkin', async (req, reply) => {
    const participant = await db.query.participants.findFirst({
      where: eq(participants.id, req.params.id),
    })
    if (!participant) return reply.code(404).send({ error: 'Participant not found' })

    const supabase = getSupabase()
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })

    const { error } = await supabase
      .from('checkins')
      .update({ checked_in_at: null })
      .eq('participant_id', participant.id)

    if (error) return reply.code(500).send({ error: error.message })

    // Mirror to local DB immediately
    await db.update(checkins).set({ checkedInAt: null, updatedAt: new Date(), syncedAt: new Date() })
      .where(eq(checkins.participantId, participant.id))

    return reply.code(204).send()
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

// Counts removed rows too, on purpose: a bib or emoji is never reused.
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

// How many results the participant has in race runs that were not cancelled.
async function liveResultCount(db, participantId) {
  const [row] = await db.select({ n: sql`count(*)` })
    .from(results)
    .innerJoin(raceRuns, eq(raceRuns.id, results.raceRunId))
    .where(and(eq(results.participantId, participantId), ne(raceRuns.status, 'cancelled')))
  return Number(row.n)
}
