import { eq, and, asc, desc, isNotNull } from 'drizzle-orm'
import { results, participants, raceRuns, categories, events, checkpointImports, checkpointReadings } from '../db/schema.js'
import { broadcast } from '../ws/broadcaster.js'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import Papa from 'papaparse'

export async function resultsRoutes(fastify) {
  const { db } = fastify

  // Results for a race run (full leaderboard)
  fastify.get('/races/:raceRunId/results', async (req) => {
    const rows = await db.query.results.findMany({
      where: eq(results.raceRunId, req.params.raceRunId),
      with: {
        participant: { with: { category: true } },
      },
      orderBy: [asc(results.position), asc(results.finishTime), asc(results.startTime)],
    })
    return { data: rows }
  })

  // All results for an event (grouped by category)
  fastify.get('/events/:eventId/results', async (req) => {
    const cats = await db.query.categories.findMany({
      where: eq(categories.eventId, req.params.eventId),
      with: {
        raceRuns: {
          orderBy: [desc(raceRuns.startedAt)],
          limit: 1,
          with: {
            results: {
              with: { participant: true },
              orderBy: [asc(results.position)],
            },
          },
        },
      },
    })
    return { data: cats }
  })

  // Patch result (manual override: time, status, note)
  fastify.patch('/results/:id', async (req, reply) => {
    const allowed = ['startTime', 'finishTime', 'status', 'statusNote']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    if (updates.status === 'dsq' && !req.body.statusNote) {
      return reply.code(400).send({ error: 'statusNote is required when setting status to dsq' })
    }

    // Convert time strings to Date objects for Drizzle
    if (updates.startTime) updates.startTime = new Date(updates.startTime)
    if (updates.finishTime) updates.finishTime = new Date(updates.finishTime)

    if (updates.startTime || updates.finishTime) {
      updates.manualOverride = true
    }

    // If startTime is being patched manually, force source tracking
    if (updates.startTime) {
      updates.startTimeSource = 'manual'
      updates.startTimeTrigger = null
    }

    const current = await db.query.results.findFirst({ where: eq(results.id, req.params.id) })
    if (!current) return reply.code(404).send({ error: 'Result not found' })

    const startTime = updates.startTime || current.startTime
    const finishTime = updates.finishTime || current.finishTime

    if (startTime && finishTime) {
      const dur = finishTime - startTime
      updates.durationMs = dur > 0 ? dur : null
    }
    // Only recalculate gunDurationMs when finishTime changes — startTime correction does not affect it
    if (updates.finishTime) {
      const run = await db.query.raceRuns.findFirst({ where: eq(raceRuns.id, current.raceRunId) })
      if (run?.startedAt) {
        const gunDur = finishTime - new Date(run.startedAt)
        updates.gunDurationMs = gunDur > 0 ? gunDur : null
      }
    }
    if (updates.finishTime && (!updates.status || updates.status === 'dnf')) {
      updates.status = 'finished'
    }

    const [row] = await db.update(results).set(updates).where(eq(results.id, req.params.id)).returning()

    await recalcPositions(db, current.raceRunId)

    const updated = await db.query.results.findFirst({ where: eq(results.id, req.params.id) })
    broadcast('result:update', updated)

    return { data: row }
  })

  // Export results as CSV
  fastify.get('/races/:raceRunId/export/csv', async (req, reply) => {
    const run = await db.query.raceRuns.findFirst({
      where: eq(raceRuns.id, req.params.raceRunId),
      with: { category: { with: { event: true } } },
    })
    if (!run) return reply.code(404).send({ error: 'Race run not found' })

    const rows = await db.query.results.findMany({
      where: eq(results.raceRunId, req.params.raceRunId),
      with: { participant: true },
      orderBy: [asc(results.position), asc(results.finishTime)],
    })

    const csvData = rows.map(r => ({
      position: r.position || '',
      bib: r.participant.bibNumber,
      first_name: r.participant.firstName,
      last_name: r.participant.lastName,
      club: r.participant.club || '',
      gender: r.participant.gender || '',
      birth_year: r.participant.birthYear || '',
      status: r.status,
      start_time: r.startTime ? new Date(r.startTime).toISOString() : '',
      finish_time: r.finishTime ? new Date(r.finishTime).toISOString() : '',
      chip_time: r.durationMs ? formatDuration(r.durationMs) : '',
      gun_time: r.gunDurationMs ? formatDuration(r.gunDurationMs) : '',
      manual_override: r.manualOverride ? 'yes' : 'no',
    }))

    const csv = Papa.unparse(csvData)
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', `attachment; filename="results-${run.category.name}.csv"`)
    return reply.send(csv)
  })

  // Export results as PDF
  fastify.get('/races/:raceRunId/export/pdf', async (req, reply) => {
    const run = await db.query.raceRuns.findFirst({
      where: eq(raceRuns.id, req.params.raceRunId),
      with: { category: { with: { event: true } } },
    })
    if (!run) return reply.code(404).send({ error: 'Race run not found' })

    const rows = await db.query.results.findMany({
      where: eq(results.raceRunId, req.params.raceRunId),
      with: { participant: true },
      orderBy: [asc(results.position), asc(results.finishTime)],
    })

    const pdfDoc = await PDFDocument.create()
    let page = pdfDoc.addPage([595, 842]) // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    const margin = 40
    let y = 800

    // Strip diacritics — pdf-lib standard fonts only support WinAnsi
    const stripDiacritics = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0142/g, 'l').replace(/\u0141/g, 'L')

    const drawText = (text, x, yPos, size = 10, f = font, color = rgb(0, 0, 0)) => {
      page.drawText(stripDiacritics(text), { x, y: yPos, size, font: f, color })
    }

    // Header
    drawText(`${run.category.event.name} — ${run.category.name}`, margin, y, 16, boldFont)
    y -= 20
    drawText(`Race started: ${run.startedAt ? new Date(run.startedAt).toLocaleString() : 'N/A'}`, margin, y, 10)
    y -= 30

    // Column headers
    const cols = [
      { label: 'Pos', x: margin, w: 30 },
      { label: 'Bib', x: margin + 35, w: 40 },
      { label: 'Name', x: margin + 80, w: 140 },
      { label: 'Club', x: margin + 225, w: 100 },
      { label: 'Chip', x: margin + 330, w: 80 },
      { label: 'Gun', x: margin + 415, w: 80 },
      { label: 'Status', x: margin + 500, w: 55 },
    ]

    for (const col of cols) drawText(col.label, col.x, y, 9, boldFont)
    y -= 4
    page.drawLine({ start: { x: margin, y }, end: { x: 555, y }, thickness: 0.5, color: rgb(0, 0, 0) })
    y -= 14

    for (const r of rows) {
      if (y < 60) {
        page = pdfDoc.addPage([595, 842])
        y = 800
      }
      const name = `${r.participant.firstName} ${r.participant.lastName}`
      drawText(r.position || '-', cols[0].x, y, 9)
      drawText(r.participant.bibNumber || '-', cols[1].x, y, 9)
      drawText(name.slice(0, 25), cols[2].x, y, 9)
      drawText((r.participant.club || '').slice(0, 17), cols[3].x, y, 9)
      drawText(r.durationMs ? formatDuration(r.durationMs) : '-', cols[4].x, y, 9)
      drawText(r.gunDurationMs ? formatDuration(r.gunDurationMs) : '-', cols[5].x, y, 9)
      drawText(r.status, cols[6].x, y, 9)
      y -= 16
    }

    const pdfBytes = await pdfDoc.save()
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="results-${run.category.name}.pdf"`)
    return reply.send(Buffer.from(pdfBytes))
  })

  // Import checkpoint data
  fastify.post('/races/:raceRunId/checkpoint-imports', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })

    const { label } = req.query
    const buf = await data.toBuffer()
    const { data: rows, errors } = Papa.parse(buf.toString('utf-8'), { header: true, skipEmptyLines: true })
    if (errors.length) return reply.code(400).send({ error: 'CSV parse error', details: errors })

    const [importRecord] = await db.insert(checkpointImports).values({
      raceRunId: req.params.raceRunId,
      label: label || 'Checkpoint',
      fileName: data.filename,
    }).returning()

    // Resolve EPCs to participants
    const run = await db.query.raceRuns.findFirst({
      where: eq(raceRuns.id, req.params.raceRunId),
      with: { category: { with: { participants: true } } },
    })

    const epcMap = new Map()
    for (const p of run.category.participants) {
      if (p.rfidEpc) epcMap.set(p.rfidEpc, p.id)
    }

    let resolved = 0
    const readings = []
    for (const row of rows) {
      if (!row.epc || !row.recorded_at) continue
      const participantId = epcMap.get(row.epc) || null
      if (participantId) resolved++
      readings.push({
        importId: importRecord.id,
        epc: row.epc,
        participantId,
        recordedAt: new Date(row.recorded_at),
        rssiCdbm: row.rssi_cdbm ? parseInt(row.rssi_cdbm) : null,
      })
    }

    if (readings.length > 0) {
      await db.insert(checkpointReadings).values(readings)
    }

    return { data: { importId: importRecord.id, total: readings.length, resolved } }
  })
}

async function recalcPositions(db, raceRunId) {
  const finished = await db
    .select({ id: results.id })
    .from(results)
    .where(and(eq(results.raceRunId, raceRunId), isNotNull(results.finishTime)))
    .orderBy(asc(results.gunDurationMs))

  for (let i = 0; i < finished.length; i++) {
    await db.update(results).set({ position: i + 1 }).where(eq(results.id, finished[i].id))
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
