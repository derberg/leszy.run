import { and, eq, isNull, isNotNull } from 'drizzle-orm'
import { participants, teamBatons } from '../db/schema.js'
import { getDetector } from '../mqtt/client.js'
import { batonRefusal, normalizeBatonEpc } from '../lib/teamBatons.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A baton-relay team's baton tag: which tag each team hands over (pałka).
export async function teamBatonsRoutes(fastify) {
  const { db } = fastify

  fastify.get('/events/:eventId/team-batons', async (req, reply) => {
    const { eventId } = req.params
    if (!UUID_RE.test(eventId)) return reply.code(400).send({ error: 'eventId must be a UUID' })
    const rows = await db.select({ teamId: teamBatons.teamId, epc: teamBatons.epc })
      .from(teamBatons).where(eq(teamBatons.eventId, eventId))
    return { data: rows }
  })

  fastify.put('/events/:eventId/team-batons/:teamId', async (req, reply) => {
    const { eventId, teamId } = req.params
    if (!UUID_RE.test(eventId) || !UUID_RE.test(teamId)) return reply.code(400).send({ error: 'eventId and teamId must be UUIDs' })
    const raw = req.body?.epc
    const [members, tagged, batons] = await Promise.all([
      db.select({ id: participants.id }).from(participants)
        .where(and(eq(participants.eventId, eventId), eq(participants.teamId, teamId),
          isNull(participants.removedAt), isNull(participants.deletedAt))),
      db.select({ epc: participants.rfidEpc }).from(participants)
        .where(and(eq(participants.eventId, eventId), isNull(participants.deletedAt), isNotNull(participants.rfidEpc))),
      db.select({ teamId: teamBatons.teamId, epc: teamBatons.epc }).from(teamBatons)
        .where(eq(teamBatons.eventId, eventId)),
    ])
    const refusal = batonRefusal({
      teamId, epc: raw === undefined ? undefined : raw, members,
      participantEpcs: tagged.map(t => t.epc), otherBatons: batons,
    })
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
    const epc = raw === null ? null : normalizeBatonEpc(raw)
    const now = new Date()
    let row
    try {
      // id = team id, like host_teams: two hosts setting one team's baton write one row, so the
      // second push updates it instead of failing on (event_id, team_id) forever.
      ;[row] = await db.insert(teamBatons).values({ id: teamId, eventId, teamId, epc, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: teamBatons.id, set: { epc, updatedAt: now }, setWhere: eq(teamBatons.eventId, eventId) })
        .returning()
    } catch (err) {
      // Two teams claiming one tag at once: the partial unique index decides.
      if (err.code === '23505') return reply.code(422).send({ error: 'Ten tag jest już przypisany pałce innej drużyny.' })
      throw err
    }
    if (!row) return reply.code(409).send({ error: 'Ta drużyna należy do innego wydarzenia.' })
    const after = await db.select({ teamId: teamBatons.teamId, epc: teamBatons.epc }).from(teamBatons)
      .where(and(eq(teamBatons.eventId, eventId), isNotNull(teamBatons.epc)))
    getDetector()?.reloadBatons(eventId, after)
    return { data: row }
  })
}
