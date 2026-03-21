import { eq, and, inArray, isNull, isNotNull } from 'drizzle-orm'
import { raceRuns, results, participants, categories, events, settings, checkpoints, checkins } from '../db/schema.js'
import { getDetector } from '../mqtt/client.js'
import { broadcast } from '../ws/broadcaster.js'

export async function racesRoutes(fastify) {
  const { db } = fastify

  // List race runs for an event (all categories)
  fastify.get('/events/:eventId/races', async (req) => {
    const cats = await db.query.categories.findMany({
      where: eq(categories.eventId, req.params.eventId),
    })
    const catIds = cats.map(c => c.id)
    if (!catIds.length) return { data: [] }

    const runs = await db.query.raceRuns.findMany({
      where: inArray(raceRuns.categoryId, catIds),
      with: { category: true },
      orderBy: raceRuns.createdAt,
    })
    return { data: runs }
  })

  // Get race runs for a category
  fastify.get('/categories/:categoryId/races', async (req) => {
    const runs = await db.query.raceRuns.findMany({
      where: eq(raceRuns.categoryId, req.params.categoryId),
      orderBy: raceRuns.createdAt,
    })
    return { data: runs }
  })

  // Start a race (create race_run and seed results)
  fastify.post('/categories/:categoryId/races', async (req, reply) => {
    // Ensure no other active race for this category
    const activeRun = await db.query.raceRuns.findFirst({
      where: and(eq(raceRuns.categoryId, req.params.categoryId), eq(raceRuns.status, 'active')),
    })
    if (activeRun) return reply.code(409).send({ error: 'A race is already active for this category' })

    const category = await db.query.categories.findFirst({
      where: eq(categories.id, req.params.categoryId),
      with: { event: true },
    })
    if (!category) return reply.code(404).send({ error: 'Category not found' })

    const now = new Date()
    const [run] = await db.insert(raceRuns).values({
      categoryId: req.params.categoryId,
      startedAt: now,
      status: 'active',
    }).returning()

    // Seed result records for all participants in this category
    const allParticipants = await db.query.participants.findMany({
      where: eq(participants.categoryId, req.params.categoryId),
      with: { checkin: true },
    })

    if (allParticipants.length > 0) {
      await db.insert(results).values(
        allParticipants.map(p => ({
          raceRunId: run.id,
          participantId: p.id,
          status: p.checkin ? 'checked_in' : 'registered',
        }))
      ).onConflictDoNothing()
    }

    // Register with crossing detector — use global MQTT topics from reader config
    const detector = getDetector()
    if (detector) {
      const [rowMain, rowFinish] = await Promise.all([
        db.select().from(settings).where(eq(settings.key, 'mqtt_topic_main')).then(r => r[0]?.value ?? 'leszyrun'),
        db.select().from(settings).where(eq(settings.key, 'mqtt_topic_finish')).then(r => r[0]?.value ?? 'leszyrun/finish'),
      ])
      await detector.startRace(run, { ...category.event, rfidTopicMain: rowMain, rfidTopicFinish: rowFinish }, allParticipants)
    }

    broadcast('race:update', { raceRunId: run.id, status: 'active', categoryId: run.categoryId })

    return reply.code(201).send({ data: run })
  })

  // Stop / cancel / update a race run
  fastify.patch('/races/:id', async (req, reply) => {
    const { status, markRemainingDnf } = req.body
    const run = await db.query.raceRuns.findFirst({ where: eq(raceRuns.id, req.params.id) })
    if (!run) return reply.code(404).send({ error: 'Race run not found' })

    const updates = {}
    if (status) updates.status = status
    if (status === 'finished' || status === 'cancelled') updates.finishedAt = new Date()

    const [updated] = await db.update(raceRuns).set(updates).where(eq(raceRuns.id, req.params.id)).returning()

    // Mark remaining participants as DNF if requested
    if (markRemainingDnf && (status === 'finished' || status === 'cancelled')) {
      await db.update(results)
        .set({ status: 'dnf' })
        .where(
          and(
            eq(results.raceRunId, req.params.id),
            inArray(results.status, ['registered', 'checked_in', 'started']),
          )
        )
    }

    // Unregister from crossing detector
    const detector = getDetector()
    if (detector && (status === 'finished' || status === 'cancelled')) {
      detector.stopRace(req.params.id)
    }

    broadcast('race:update', { raceRunId: updated.id, status: updated.status, categoryId: updated.categoryId })

    return { data: updated }
  })

  // Audit data for a race run
  fastify.get('/races/:raceRunId/audit', async (req, reply) => {
    const raceRunId = req.params.raceRunId

    // Fetch results where start_time_source is 'gun' or 'manual'
    const rows = await db.select({
      resultId:        results.id,
      participantId:   results.participantId,
      startTime:       results.startTime,
      finishTime:      results.finishTime,
      durationMs:      results.durationMs,
      gunDurationMs:   results.gunDurationMs,
      startTimeSource: results.startTimeSource,
      startTimeTrigger: results.startTimeTrigger,
      firstName:       participants.firstName,
      lastName:        participants.lastName,
      bibNumber:       participants.bibNumber,
      emoji:           participants.emoji,
    })
      .from(results)
      .innerJoin(participants, eq(results.participantId, participants.id))
      .where(
        and(
          eq(results.raceRunId, raceRunId),
          inArray(results.startTimeSource, ['gun', 'manual']),
        )
      )
      .orderBy(results.startTime)

    // Resolve checkpoint names for checkpoint:uuid triggers
    const checkpointIds = [...new Set(
      rows
        .filter(r => r.startTimeTrigger?.startsWith('checkpoint:'))
        .map(r => r.startTimeTrigger.replace('checkpoint:', ''))
    )]

    const cpMap = {}
    if (checkpointIds.length) {
      const cps = await db.select({ id: checkpoints.id, name: checkpoints.name })
        .from(checkpoints)
        .where(inArray(checkpoints.id, checkpointIds))
      for (const cp of cps) cpMap[cp.id] = cp.name
    }

    const gunStartFallback = rows.map(r => {
      let checkpointName = null
      if (r.startTimeTrigger?.startsWith('checkpoint:')) {
        const cpId = r.startTimeTrigger.replace('checkpoint:', '')
        checkpointName = cpMap[cpId] ?? null  // null = deleted checkpoint; frontend shows fallback label
      }
      return { ...r, checkpointName }
    })

    // Find checked-in participants in this race's category who have no start time yet
    const run = await db.query.raceRuns.findFirst({
      where: eq(raceRuns.id, raceRunId),
      with: { category: true },
    })

    let missingStart = []
    if (run) {
      // All checked-in participants in this category with an RFID tag
      const checkedIn = await db.select({
        participantId: participants.id,
        firstName: participants.firstName,
        lastName: participants.lastName,
        bibNumber: participants.bibNumber,
        emoji: participants.emoji,
        rfidEpc: participants.rfidEpc,
      })
        .from(participants)
        .innerJoin(checkins, eq(checkins.participantId, participants.id))
        .where(
          and(
            eq(participants.categoryId, run.categoryId),
            isNotNull(checkins.checkedInAt),
            isNotNull(participants.rfidEpc),
          )
        )

      // Filter out those who already have a start time for this race run
      const existingResults = await db.select({
        participantId: results.participantId,
        startTime: results.startTime,
      })
        .from(results)
        .where(eq(results.raceRunId, raceRunId))

      const startedIds = new Set(existingResults.filter(r => r.startTime).map(r => r.participantId))
      missingStart = checkedIn.filter(p => !startedIds.has(p.participantId))
    }

    return { data: { gunStartFallback, missingStart } }
  })

  // Assign gun time to participants missing a start crossing
  fastify.post('/races/:raceRunId/assign-gun-start', async (req, reply) => {
    const raceRunId = req.params.raceRunId
    const { participantIds } = req.body || {}
    if (!participantIds?.length) return reply.code(400).send({ error: 'participantIds required' })

    const run = await db.query.raceRuns.findFirst({ where: eq(raceRuns.id, raceRunId) })
    if (!run) return reply.code(404).send({ error: 'Race run not found' })
    if (!run.startedAt) return reply.code(400).send({ error: 'Race has not started' })

    const gunStartTime = new Date(run.startedAt)
    let assigned = 0

    for (const participantId of participantIds) {
      // Don't overwrite existing chip start
      const existing = await db.query.results.findFirst({
        where: and(eq(results.raceRunId, raceRunId), eq(results.participantId, participantId)),
      })
      if (existing?.startTime) continue

      await db.insert(results).values({
        raceRunId,
        participantId,
        startTime: gunStartTime,
        status: 'started',
        startTimeSource: 'gun',
        startTimeTrigger: 'manual_backfill',
      }).onConflictDoUpdate({
        target: [results.raceRunId, results.participantId],
        set: { startTime: gunStartTime, status: 'started', startTimeSource: 'gun', startTimeTrigger: 'manual_backfill' },
      })
      assigned++
    }

    // Update in-memory detector state
    const detector = getDetector()
    if (detector) {
      const race = detector.activeRaces.get(raceRunId)
      if (race) {
        for (const pid of participantIds) race.startedParticipants.add(pid)
      }
    }

    broadcast('race:update', { raceRunId, status: run.status })
    return { data: { assigned } }
  })
}
