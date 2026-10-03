import { createReadStream, promises as fs } from 'fs'
import path from 'path'
import { eq, and, desc, sql, isNull, isNotNull } from 'drizzle-orm'
import { visionSessions, visionSightings, participants } from '../db/schema.js'
import { startIngest, stopIngest, sessionStats, healthVerdict } from '../vision/ingest.js'
import { safeCropPath, safeFramePath } from '../vision/paths.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

async function loadSession(db, id) {
  const [row] = await db.select().from(visionSessions)
    .where(eq(visionSessions.id, id)).limit(1)
  return row ?? null
}

async function serveImage(reply, file, notFoundHint) {
  if (!file) return reply.code(400).send({ error: 'Invalid image reference' })
  try {
    await fs.access(file)
  } catch {
    return reply.code(404).send({ error: notFoundHint })
  }
  // Photographs never leave this machine, so they must never be cached by a
  // proxy on the way to the browser either.
  reply.header('Content-Type', 'image/jpeg')
  reply.header('Cache-Control', 'private, max-age=60')
  return reply.send(createReadStream(file))
}

export async function visionRoutes(fastify) {
  const db = fastify.db

  // ─── sessions ─────────────────────────────────────────────────────────

  // GET /api/events/:eventId/vision/sessions
  fastify.get('/events/:eventId/vision/sessions', async (req) => {
    const rows = await db.select().from(visionSessions)
      .where(eq(visionSessions.eventId, req.params.eventId))
      .orderBy(desc(visionSessions.startedAt))
    return { data: rows.map(r => ({ ...r, verdict: healthVerdict(r.health) })) }
  })

  // POST /api/events/:eventId/vision/sessions
  // Starts watching a queue directory. The camera does not have to be running
  // yet — this is the thing an operator opens BEFORE a race to check it.
  fastify.post('/events/:eventId/vision/sessions', async (req, reply) => {
    const { queueDir, label, raceRunId } = req.body ?? {}
    if (!queueDir || typeof queueDir !== 'string') {
      return reply.code(400).send({ error: 'queueDir is required' })
    }
    const dir = path.resolve(queueDir)
    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch {
      return reply.code(400).send({
        error: `Nie ma takiego katalogu: ${dir}. Uruchom najpierw capture.py.`,
      })
    }

    // The offset is written once per capture session and is what turns a
    // sensor nanosecond into a wall clock. Without it no sighting can be
    // matched to a gun time.
    let clockOffset = null
    try {
      clockOffset = JSON.parse(
        await fs.readFile(path.join(dir, 'session.json'), 'utf8'),
      ).offset ?? null
    } catch { /* capture has not started yet; it will appear */ }

    const [row] = await db.insert(visionSessions).values({
      eventId: req.params.eventId,
      raceRunId: raceRunId ?? null,
      label: label ?? null,
      queueDir: dir,
      clockOffset,
    }).returning()

    startIngest(db, row.id)
    return reply.code(201).send({ data: row })
  })

  // POST /api/vision/sessions/:id/stop
  fastify.post('/vision/sessions/:id/stop', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    stopIngest(session.id)
    const [row] = await db.update(visionSessions)
      .set({ stoppedAt: new Date() })
      .where(eq(visionSessions.id, session.id)).returning()
    return { data: row }
  })

  // POST /api/vision/sessions/:id/resume
  fastify.post('/vision/sessions/:id/resume', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const [row] = await db.update(visionSessions)
      .set({ stoppedAt: null })
      .where(eq(visionSessions.id, session.id)).returning()
    startIngest(db, row.id)
    return { data: row }
  })

  // DELETE /api/vision/sessions/:id
  // Drops the rows. It deliberately does NOT delete the frames: those are the
  // evidence, and removing a race's photographs is a retention decision taken
  // by the purge job, not a side effect of tidying a list.
  fastify.delete('/vision/sessions/:id', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    stopIngest(session.id)
    await db.delete(visionSessions).where(eq(visionSessions.id, session.id))
    return reply.code(204).send()
  })

  // GET /api/vision/sessions/:id — session, live health, stats
  fastify.get('/vision/sessions/:id', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    const rows = await db.select({
      bibNumber: visionSightings.bibNumber,
      participantId: visionSightings.participantId,
      confidence: visionSightings.confidence,
      frameCount: visionSightings.frameCount,
    }).from(visionSightings).where(eq(visionSightings.sessionId, session.id))

    return {
      data: {
        ...session,
        verdict: healthVerdict(session.health),
        stats: sessionStats(rows),
      },
    }
  })

  // ─── sightings ────────────────────────────────────────────────────────

  // GET /api/vision/sessions/:id/sightings?limit&filter&bib
  // filter: all | unreadable | unmatched | matched
  fastify.get('/vision/sessions/:id/sightings', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    const limit = Math.min(
      parseInt(req.query.limit ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, MAX_LIMIT,
    )
    const where = [eq(visionSightings.sessionId, session.id)]
    if (req.query.filter === 'unreadable') {
      where.push(isNull(visionSightings.bibNumber))
    } else if (req.query.filter === 'unmatched') {
      // A number that matches nobody in this race. Almost always a misread,
      // and the most useful thing on the screen when judging quality.
      where.push(isNotNull(visionSightings.bibNumber))
      where.push(isNull(visionSightings.participantId))
    } else if (req.query.filter === 'matched') {
      where.push(isNotNull(visionSightings.participantId))
    }
    if (req.query.bib) where.push(eq(visionSightings.bibNumber, String(req.query.bib)))

    const rows = await db.select({
      id: visionSightings.id,
      bibNumber: visionSightings.bibNumber,
      participantId: visionSightings.participantId,
      confidence: visionSightings.confidence,
      frameCount: visionSightings.frameCount,
      sightedAt: visionSightings.sightedAt,
      bestFrameTs: visionSightings.bestFrameTs,
      cropName: visionSightings.cropName,
      votes: visionSightings.votes,
      firstName: participants.firstName,
      lastName: participants.lastName,
    })
      .from(visionSightings)
      .leftJoin(participants, eq(participants.id, visionSightings.participantId))
      .where(and(...where))
      .orderBy(desc(visionSightings.sightedAt))
      .limit(limit)

    return { data: rows }
  })

  // ─── images (local only — never Supabase, never cached publicly) ──────

  // GET /api/vision/sessions/:id/crop/:name
  // The crop holds digits and nothing else: no person, no face.
  fastify.get('/vision/sessions/:id/crop/:name', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    return serveImage(
      reply, safeCropPath(session.queueDir, req.params.name),
      'Wycinek nie istnieje — mógł zostać usunięty przez retencję.',
    )
  })

  // GET /api/vision/sessions/:id/frame/:ts
  // A FULL frame. It contains a whole person and a face, so it is behind an
  // explicit click in the UI, never shown in a list. It is served by this
  // backend on the capture machine and goes nowhere else.
  fastify.get('/vision/sessions/:id/frame/:ts', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    // The reader moves a frame into done/ once it has read it, so look there
    // too rather than reporting a frame missing the moment it is processed.
    for (const done of [false, true]) {
      const file = safeFramePath(session.queueDir, String(req.params.ts), { done })
      if (!file) return reply.code(400).send({ error: 'Invalid frame reference' })
      try {
        await fs.access(file)
        reply.header('Content-Type', 'image/jpeg')
        reply.header('Cache-Control', 'private, max-age=60')
        return reply.send(createReadStream(file))
      } catch { /* try done/ */ }
    }
    return reply.code(404).send({
      error: 'Klatka nie istnieje — mogła zostać usunięta przez retencję.',
    })
  })
}
