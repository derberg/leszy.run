import { eq } from 'drizzle-orm'
import { raceRuns, participants, teamLaps } from '../db/schema.js'
import { broadcast } from '../ws/broadcaster.js'
import { getDetector } from '../mqtt/client.js'
import { lapEdit } from '../lib/teamLapEdits.js'

// Operator corrections of a relay-in-any-order lap: add one the chip missed, move one to the
// teammate who really ran it, fix its time, remove a false one (and undo that). A removed lap
// keeps its row with deleted_at set, because a DELETE would never reach the other hosts.
export async function teamLapsRoutes(fastify) {
  const { db } = fastify

  const loadRun = (id) => db.query.raceRuns.findFirst({ where: eq(raceRuns.id, id), with: { category: true } })
  const loadParticipant = (id) => id ? db.query.participants.findFirst({ where: eq(participants.id, id) }) : null

  // Every lap of the run, removed ones included (the panel shows them struck through).
  fastify.get('/races/:raceRunId/team-laps', async (req) => {
    const rows = await db.select().from(teamLaps).where(eq(teamLaps.raceRunId, req.params.raceRunId))
    return { data: rows }
  })

  fastify.post('/races/:raceRunId/team-laps', async (req, reply) => {
    const run = await loadRun(req.params.raceRunId)
    if (!run) return reply.code(404).send({ error: 'Race run not found' })
    const body = req.body ?? {}
    const out = lapEdit({ run, participant: await loadParticipant(body.participantId), lap: null, body })
    if (out.error) return reply.code(out.status).send({ error: out.error })
    const [row] = await db.insert(teamLaps).values({ raceRunId: run.id, ...out.values }).returning()
    await afterEdit(run.id, row)
    return reply.code(201).send({ data: row })
  })

  fastify.patch('/team-laps/:id', async (req, reply) => {
    const lap = await db.query.teamLaps.findFirst({ where: eq(teamLaps.id, req.params.id) })
    if (!lap) return reply.code(404).send({ error: 'Lap not found' })
    const run = await loadRun(lap.raceRunId)
    const body = req.body ?? {}
    const out = lapEdit({ run, participant: await loadParticipant(body.participantId), lap, body })
    if (out.error) return reply.code(out.status).send({ error: out.error })
    if (!Object.keys(out.values).length) return reply.code(400).send({ error: 'No fields to update' })
    const [row] = await db.update(teamLaps).set(out.values).where(eq(teamLaps.id, lap.id)).returning()
    await afterEdit(run.id, row)
    return { data: row }
  })

  // The detector counts from the corrected laps, and every open panel refetches.
  async function afterEdit(raceRunId, row) {
    await getDetector()?.reloadTeamLaps(raceRunId)
    broadcast('team:lap', { ...row, corrected: true })
  }
}
