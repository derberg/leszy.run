import { eq, and, isNull, inArray } from 'drizzle-orm'
import { participants, events } from '../db/schema.js'
import { sendSms } from '../sms/smsapi.js'

export async function smsRoutes(fastify) {
  const { db } = fastify

  fastify.post('/events/:eventId/sms/checkin', async (req, reply) => {
    const { participantIds } = req.body
    if (!participantIds?.length) return reply.code(400).send({ error: 'participantIds required' })
    const event = await db.query.events.findFirst({ where: eq(events.id, req.params.eventId) })
    if (!event) return reply.code(404).send({ error: 'Event not found' })
    if (!event.slug) return reply.code(400).send({ error: 'Event has no slug — set one in event settings first' })
    const rows = await db.query.participants.findMany({
      where: and(eq(participants.eventId, req.params.eventId), inArray(participants.id, participantIds)),
    })
    return await sendCheckinSms(db, event, rows)
  })

  fastify.post('/events/:eventId/sms/checkin-all', async (req, reply) => {
    const event = await db.query.events.findFirst({ where: eq(events.id, req.params.eventId) })
    if (!event) return reply.code(404).send({ error: 'Event not found' })
    if (!event.slug) return reply.code(400).send({ error: 'Event has no slug — set one in event settings first' })
    const rows = await db.query.participants.findMany({
      where: and(eq(participants.eventId, req.params.eventId), isNull(participants.smsSentAt)),
    })
    return await sendCheckinSms(db, event, rows)
  })
}

async function sendCheckinSms(db, event, participantRows) {
  let sent = 0, skipped = 0
  const errors = []
  for (const p of participantRows) {
    if (!p.phone) { skipped++; continue }
    const message = `Cześć ${p.firstName}! Zamelduj się na ${event.name}: https://leszy.run/events/${event.slug}/checkin?p=${p.id}`
    try {
      const result = await sendSms(p.phone, message)
      if (result.success) {
        await db.update(participants).set({ smsSentAt: new Date() }).where(eq(participants.id, p.id))
        sent++
      } else { errors.push({ participantId: p.id, message: result.error }) }
    } catch (err) { errors.push({ participantId: p.id, message: err.message }) }
  }
  return { data: { sent, skipped, errors } }
}
