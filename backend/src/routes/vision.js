import { createReadStream, promises as fs } from 'fs'
import path from 'path'
import { eq, and, desc, asc, sql, ne, isNull, isNotNull, notInArray } from 'drizzle-orm'
import {
  visionSessions, visionSightings, visionReviews, participants, results, raceRuns, categories,
} from '../db/schema.js'
import { startIngest, stopIngest, sessionStats, healthVerdict, openSessionOn } from '../vision/ingest.js'
import { safeCropPath, safeFramePath } from '../vision/paths.js'
import { readRecording, writeRecording } from '../vision/recording.js'
import { frameStamps, framesAround, parseVerdict, likelyMisread, MATCH_MS } from '../vision/review.js'

// A DNS or DNF keeps whatever finish the chip gave it, but the operator has
// said the runner never crossed the line, so there is nothing to look for in
// the frames. At Wilczy Półmaraton 2026 two unworn bibs carried past the gate
// got a finish at the same instant. A DSQ runner did cross and stays.
const NOT_FINISHERS = ['dns', 'dnf']

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
    const data = await Promise.all(rows.map(async (r) => {
      const { recording } = await readRecording(r.queueDir)
      return { ...r, verdict: healthVerdict(r.health, { recording }) }
    }))
    return { data }
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

    const open = await db.select().from(visionSessions)
      .where(isNull(visionSessions.stoppedAt))
    const existing = openSessionOn(open, dir)
    if (existing) {
      return reply.code(409).send({
        error: `Ten katalog obserwuje już otwarta sesja „${existing.label || existing.queueDir}”. Wybierz ją z listy.`,
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
    const open = await db.select().from(visionSessions)
      .where(isNull(visionSessions.stoppedAt))
    const existing = openSessionOn(open.filter(s => s.id !== session.id), session.queueDir)
    if (existing) {
      return reply.code(409).send({
        error: `Ten katalog obserwuje już otwarta sesja „${existing.label || existing.queueDir}”. Zatrzymaj ją najpierw.`,
      })
    }
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

    const { recording } = await readRecording(session.queueDir)
    return {
      data: {
        ...session,
        verdict: healthVerdict(session.health, { recording }),
        stats: sessionStats(rows),
      },
    }
  })

  // ─── recording switch ─────────────────────────────────────────────────

  // GET /api/vision/sessions/:id/recording
  // Read from the file capture.py reads, never from a copy of our own, so the
  // panel shows what the camera is doing rather than what was last asked.
  fastify.get('/vision/sessions/:id/recording', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    return { data: await readRecording(session.queueDir) }
  })

  // PUT /api/vision/sessions/:id/recording  { recording: boolean }
  fastify.put('/vision/sessions/:id/recording', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const { recording } = req.body ?? {}
    if (typeof recording !== 'boolean') {
      return reply.code(400).send({ error: 'recording must be true or false' })
    }
    try {
      return { data: await writeRecording(session.queueDir, recording) }
    } catch {
      return reply.code(409).send({
        error: `Nie można zapisać przełącznika w ${session.queueDir}. Sprawdź, czy katalog kolejki istnieje.`,
      })
    }
  })

  // ─── sightings ────────────────────────────────────────────────────────

  // GET /api/vision/sessions/:id/sightings?limit&offset&filter&bib
  // filter: all | unreadable | unmatched | matched | suspect
  // Each row carries `suspect` (likelyMisread): a read that is probably
  // somebody else's number, for a person to check against the frame.
  // `total` counts every row the filter matches, so the tab can page through a
  // whole race: a three-hour session holds thousands of tracks.
  fastify.get('/vision/sessions/:id/sightings', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    const limit = Math.min(
      parseInt(req.query.limit ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, MAX_LIMIT,
    )
    const offset = Math.max(0, parseInt(req.query.offset ?? 0, 10) || 0)
    const where = [eq(visionSightings.sessionId, session.id)]
    if (req.query.filter === 'unreadable') {
      where.push(isNull(visionSightings.bibNumber))
    } else if (req.query.filter === 'unmatched') {
      // A number that matches nobody in this race. Almost always a misread,
      // and the most useful thing on the screen when judging quality.
      where.push(isNotNull(visionSightings.bibNumber))
      where.push(isNull(visionSightings.participantId))
    } else if (req.query.filter === 'matched' || req.query.filter === 'suspect') {
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
      frameTs: visionSightings.frameTs,
      firstName: participants.firstName,
      lastName: participants.lastName,
    })
      .from(visionSightings)
      .leftJoin(participants, eq(participants.id, visionSightings.participantId))
      .where(and(...where))
      .orderBy(desc(visionSightings.sightedAt), desc(visionSightings.id))
      .limit(req.query.filter === 'suspect' ? MAX_LIMIT : limit)
      .offset(req.query.filter === 'suspect' ? 0 : offset)

    const field = (await db.select({
      bibNumber: participants.bibNumber,
      status: results.status,
      finishTime: results.finishTime,
    })
      .from(results)
      .innerJoin(participants, eq(participants.id, results.participantId))
      .innerJoin(raceRuns, eq(raceRuns.id, results.raceRunId))
      .innerJoin(categories, eq(categories.id, raceRuns.categoryId))
      .where(and(eq(categories.eventId, session.eventId), ne(raceRuns.status, 'cancelled'))))
      .map(r => ({
        bibNumber: r.bibNumber == null ? null : String(r.bibNumber),
        status: r.status,
        finishMs: r.finishTime ? new Date(r.finishTime).getTime() : null,
      }))

    let data = rows.map(r => ({
      ...r,
      suspect: likelyMisread({ bibNumber: r.bibNumber, sightedAtMs: new Date(r.sightedAt).getTime() }, field),
    }))
    let total
    if (req.query.filter === 'suspect') {
      // Suspect is decided here, not in SQL, so it pages in memory.
      data = data.filter(r => r.suspect)
      total = data.length
      data = data.slice(offset, offset + limit)
    } else {
      const [count] = await db.select({ n: sql`count(*)::int` })
        .from(visionSightings)
        .where(and(...where))
      total = count.n
    }
    return { data, total, limit, offset }
  })

  // ─── review: finishers the camera did not read ────────────────────────

  // GET /api/vision/sessions/:id/review?filter=unread|all
  // Every chip finisher of the session's event, whether the camera read their
  // number within MATCH_MS of the chip finish, and a person's verdict if one
  // was given. `unread` keeps the rows with no read.
  fastify.get('/vision/sessions/:id/review', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    const rows = await db.select({
      participantId: results.participantId,
      bibNumber: participants.bibNumber,
      firstName: participants.firstName,
      lastName: participants.lastName,
      category: categories.name,
      finishTime: results.finishTime,
      cameraRead: sql`exists (
        select 1 from ${visionSightings} s
        where s.session_id = ${session.id}
          and s.participant_id = ${results.participantId}
          and abs(extract(epoch from (s.sighted_at - ${results.finishTime}))) * 1000 <= ${MATCH_MS}
      )`.mapWith(Boolean),
      verdict: visionReviews.verdict,
      reviewBib: visionReviews.bibNumber,
      reviewFrameTs: visionReviews.frameTs,
      reviewX: visionReviews.x,
      reviewY: visionReviews.y,
    })
      .from(results)
      .innerJoin(participants, eq(participants.id, results.participantId))
      .innerJoin(raceRuns, eq(raceRuns.id, results.raceRunId))
      .innerJoin(categories, eq(categories.id, raceRuns.categoryId))
      .leftJoin(visionReviews, and(
        eq(visionReviews.sessionId, session.id),
        eq(visionReviews.participantId, results.participantId),
      ))
      .where(and(
        eq(categories.eventId, session.eventId),
        ne(raceRuns.status, 'cancelled'),
        isNotNull(results.finishTime),
        notInArray(results.status, NOT_FINISHERS),
      ))
      .orderBy(asc(results.finishTime))

    const data = req.query.filter === 'all' ? rows : rows.filter(r => !r.cameraRead)
    return {
      data,
      total: rows.length,
      read: rows.filter(r => r.cameraRead).length,
      reviewed: rows.filter(r => r.verdict).length,
    }
  })

  // GET /api/vision/sessions/:id/review/:participantId/frames
  // The frames around this finisher's chip time, oldest first. `?raceRunId=`
  // names the run; without it the newest run with a finish is used, so a
  // rehearsal left `finished` instead of `cancelled` cannot centre the window.
  fastify.get('/vision/sessions/:id/review/:participantId/frames', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const [row] = await db.select({ finishTime: results.finishTime })
      .from(results)
      .innerJoin(raceRuns, eq(raceRuns.id, results.raceRunId))
      .where(and(
        eq(results.participantId, req.params.participantId),
        ne(raceRuns.status, 'cancelled'),
        isNotNull(results.finishTime),
        req.query.raceRunId ? eq(results.raceRunId, String(req.query.raceRunId)) : undefined,
      ))
      .orderBy(desc(results.finishTime))
      .limit(1)
    if (!row) return reply.code(404).send({ error: 'No chip finish for this participant' })
    const stamps = await frameStamps(session.queueDir)
    const frames = framesAround(stamps, session.clockOffset, new Date(row.finishTime).getTime())
    return { data: frames.map(String) }
  })

  // PUT /api/vision/sessions/:id/review/:participantId
  // { verdict, bibNumber?, frameTs?, x?, y? }
  fastify.put('/vision/sessions/:id/review/:participantId', async (req, reply) => {
    const session = await loadSession(db, req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const parsed = parseVerdict(req.body)
    if (parsed.error) return reply.code(400).send({ error: parsed.error })
    const values = {
      sessionId: session.id,
      participantId: req.params.participantId,
      ...parsed.value,
    }
    const [row] = await db.insert(visionReviews).values(values)
      .onConflictDoUpdate({
        target: [visionReviews.sessionId, visionReviews.participantId],
        set: { ...parsed.value, updatedAt: new Date() },
      })
      .returning()
    return { data: row }
  })

  // DELETE /api/vision/sessions/:id/review/:participantId
  fastify.delete('/vision/sessions/:id/review/:participantId', async (req) => {
    await db.delete(visionReviews).where(and(
      eq(visionReviews.sessionId, req.params.id),
      eq(visionReviews.participantId, req.params.participantId),
    ))
    return { data: null }
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
