import { eq, inArray, and, desc } from 'drizzle-orm'
import { checkpoints, checkpointCategories, checkpointObservations, raceRuns, categories, participants, results } from '../db/schema.js'
import { syncDelete } from '../sync/supabase.js'
import { broadcast } from '../ws/broadcaster.js'

export async function checkpointsRoutes(fastify) {
  const db = fastify.db

  // List checkpoints for an event (with their category IDs)
  fastify.get('/events/:eventId/checkpoints', async (req, reply) => {
    const rows = await db.select().from(checkpoints)
      .where(eq(checkpoints.eventId, req.params.eventId))
      .orderBy(checkpoints.kmMarker, checkpoints.createdAt)

    const catLinks = rows.length
      ? await db.select().from(checkpointCategories)
          .where(inArray(checkpointCategories.checkpointId, rows.map(r => r.id)))
      : []

    const catsByCheckpoint = {}
    for (const link of catLinks) {
      if (!catsByCheckpoint[link.checkpointId]) catsByCheckpoint[link.checkpointId] = []
      catsByCheckpoint[link.checkpointId].push(link.categoryId)
    }

    return { data: rows.map(r => ({ ...r, categoryIds: catsByCheckpoint[r.id] || [] })) }
  })

  // Create checkpoint
  fastify.post('/events/:eventId/checkpoints', async (req, reply) => {
    const { name, kmMarker, categoryIds = [], private: isPrivate } = req.body
    if (!name) return reply.code(400).send({ error: 'name required' })

    const [row] = await db.insert(checkpoints)
      .values({ eventId: req.params.eventId, name, kmMarker: kmMarker || null, private: isPrivate ?? false })
      .returning()

    if (categoryIds.length) {
      await db.insert(checkpointCategories)
        .values(categoryIds.map(cid => ({ checkpointId: row.id, categoryId: cid })))
    }

    return reply.code(201).send({ data: { ...row, categoryIds } })
  })

  // Update checkpoint
  fastify.patch('/checkpoints/:id', async (req, reply) => {
    const { name, kmMarker, categoryIds, private: isPrivate } = req.body
    const updates = {}
    if (name !== undefined) updates.name = name
    if (kmMarker !== undefined) updates.kmMarker = kmMarker
    if (isPrivate !== undefined) updates.private = isPrivate

    const [row] = await db.update(checkpoints)
      .set(updates)
      .where(eq(checkpoints.id, req.params.id))
      .returning()

    if (!row) return reply.code(404).send({ error: 'not found' })

    if (categoryIds !== undefined) {
      await db.delete(checkpointCategories).where(eq(checkpointCategories.checkpointId, row.id))
      if (categoryIds.length) {
        await db.insert(checkpointCategories)
          .values(categoryIds.map(cid => ({ checkpointId: row.id, categoryId: cid })))
      }
    }

    const catLinks = await db.select().from(checkpointCategories)
      .where(eq(checkpointCategories.checkpointId, row.id))

    return { data: { ...row, categoryIds: catLinks.map(l => l.categoryId) } }
  })

  // Delete checkpoint
  fastify.delete('/checkpoints/:id', async (req, reply) => {
    await db.delete(checkpoints).where(eq(checkpoints.id, req.params.id))
    syncDelete('checkpoints', req.params.id)
    return reply.code(204).send()
  })

  // List observations for a checkpoint (for debugging/admin)
  fastify.get('/checkpoints/:id/observations', async (req, reply) => {
    const rows = await db.select().from(checkpointObservations)
      .where(eq(checkpointObservations.checkpointId, req.params.id))
      .orderBy(checkpointObservations.observedAt)
    return { data: rows }
  })

  // POST observation for a checkpoint — records a volunteer scan and applies gun-start fallback
  fastify.post('/checkpoints/:id/observations', async (req, reply) => {
    const { observedAt } = req.body
    const bib = parseInt(req.body.bibNumber, 10)
    if (!bib) return reply.code(400).send({ error: 'bibNumber required' })
    const bibNumber = bib

    const checkpointId = req.params.id

    // Fetch checkpoint to get its eventId (needed to resolve participant by bib)
    const [checkpoint] = await db.select({ id: checkpoints.id, eventId: checkpoints.eventId })
      .from(checkpoints)
      .where(eq(checkpoints.id, checkpointId))

    if (!checkpoint) return reply.code(404).send({ error: 'Checkpoint not found' })

    // Resolve participantId from bibNumber + eventId
    const [p] = await db.select({ id: participants.id, categoryId: participants.categoryId })
      .from(participants)
      .where(and(eq(participants.eventId, checkpoint.eventId), eq(participants.bibNumber, bibNumber)))

    // Insert observation (participantId may be null if bib not found — record it anyway)
    const [obs] = await db.insert(checkpointObservations).values({
      checkpointId,
      bibNumber,
      participantId: p?.id || null,
      observedAt: observedAt ? new Date(observedAt) : new Date(),
    }).returning()

    // Gun-start fallback: only possible if participant was resolved
    if (p?.id && p?.categoryId) {
      // 1. Verify checkpoint is linked to this participant's category
      const [catLink] = await db.select({ checkpointId: checkpointCategories.checkpointId })
        .from(checkpointCategories)
        .where(and(
          eq(checkpointCategories.checkpointId, checkpointId),
          eq(checkpointCategories.categoryId, p.categoryId),
        ))

      if (catLink) {
        // 2. Find active race run for this category (most recent started_at)
        const [activeRun] = await db.select()
          .from(raceRuns)
          .where(and(eq(raceRuns.categoryId, p.categoryId), eq(raceRuns.status, 'active')))
          .orderBy(desc(raceRuns.startedAt))
          .limit(1)

        if (activeRun) {
          // 3. Apply gun-start fallback if no startTime yet
          const [result] = await db.select({ id: results.id, startTime: results.startTime })
            .from(results)
            .where(and(eq(results.raceRunId, activeRun.id), eq(results.participantId, p.id)))

          if (result && !result.startTime) {
            const [updated] = await db.update(results)
              .set({
                startTime: activeRun.startedAt,
                startTimeSource: 'gun',
                startTimeTrigger: `checkpoint:${checkpointId}`,
                status: 'started',
              })
              .where(and(eq(results.raceRunId, activeRun.id), eq(results.participantId, p.id)))
              .returning()

            if (updated) {
              const full = await db.query.results.findFirst({ where: eq(results.id, updated.id) })
              broadcast('result:update', full)
            }
          }
        }
      }
    }

    return reply.code(201).send({ data: obs })
  })

  // List observations for a race run — only checkpoints assigned to the race's category
  fastify.get('/races/:raceRunId/checkpoint-observations', async (req, reply) => {
    const [run] = await db.select({ categoryId: raceRuns.categoryId })
      .from(raceRuns).where(eq(raceRuns.id, req.params.raceRunId))
    if (!run) return reply.code(404).send({ error: 'race run not found' })

    const [cat] = await db.select({ eventId: categories.eventId })
      .from(categories).where(eq(categories.id, run.categoryId))
    if (!cat) return reply.code(404).send({ error: 'category not found' })

    // Get all event checkpoints
    const allCps = await db.select({ id: checkpoints.id })
      .from(checkpoints).where(eq(checkpoints.eventId, cat.eventId))
    if (!allCps.length) return { data: [] }

    // Get category links to filter checkpoints
    const catLinks = await db.select({ checkpointId: checkpointCategories.checkpointId, categoryId: checkpointCategories.categoryId })
      .from(checkpointCategories)
      .where(inArray(checkpointCategories.checkpointId, allCps.map(c => c.id)))

    // Build set of checkpoints that have category restrictions
    const restrictedCheckpoints = new Set(catLinks.map(l => l.checkpointId))

    // Checkpoints assigned to this category (explicitly linked OR no category restriction)
    const categoryLinkedIds = new Set(
      catLinks.filter(l => l.categoryId === run.categoryId).map(l => l.checkpointId)
    )
    const cps = allCps.filter(c =>
      !restrictedCheckpoints.has(c.id) || categoryLinkedIds.has(c.id)
    )
    if (!cps.length) return { data: [] }

    // Get observations for matching checkpoints
    const rows = await db.select()
      .from(checkpointObservations)
      .where(inArray(checkpointObservations.checkpointId, cps.map(c => c.id)))
      .orderBy(checkpointObservations.observedAt)

    // Filter out observations from participants in other categories
    // (volunteer may enter a bib from the wrong category by mistake)
    const categoryParticipants = await db.select({ id: participants.id })
      .from(participants)
      .where(eq(participants.categoryId, run.categoryId))
    const validParticipantIds = new Set(categoryParticipants.map(p => p.id))

    const filtered = rows.filter(o =>
      !o.participantId || validParticipantIds.has(o.participantId)
    )

    return { data: filtered }
  })
}
