import { createReadStream, promises as fs } from 'fs'
import path from 'path'
import { eq, and, sql } from 'drizzle-orm'
import { visionSessions, visionSightings, participants } from '../db/schema.js'
import { broadcast } from '../ws/broadcaster.js'

// How often the backend looks at the log. The reader is throttled to a few
// frames a second, so a runner takes seconds to cross and a one-second poll
// is already faster than the thing it watches.
const POLL_MS = 1000

// The reader rewrites health.json every two seconds. Three missed writes and
// it is not running.
const HEARTBEAT_DEAD_AFTER_S = 8

const BUCKETS = [['1-4', 1, 4], ['5-9', 5, 9], ['10-24', 10, 24], ['25+', 25, Infinity]]

/**
 * Split a chunk of the append-only log into whole records.
 *
 * The reader appends while this runs, so the last line in the buffer may be
 * half written. Consuming it would turn one runner into two rows, the second
 * a crossing with no bib — indistinguishable on screen from a genuine
 * unreadable runner. So the cursor only ever advances past a newline, and the
 * torn tail is re-read whole on the next poll.
 *
 * The cursor is a BYTE offset. A character offset would desync on the first
 * non-ASCII byte and shift every line after it.
 */
export function parseLog(buffer, cursor) {
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline === -1) return { records: [], nextCursor: cursor }

  const complete = buffer.subarray(0, lastNewline + 1).toString('utf8')
  const records = []
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // One malformed line must not stall ingest for the rest of the race.
      // It is counted by its absence; the cursor still moves past it.
    }
  }
  return { records, nextCursor: cursor + lastNewline + 1 }
}

/**
 * Resolve a recognised number against this race's roster.
 *
 * Exact string match, deliberately. A bib printed `007` can exist alongside a
 * bib `7`, and normalising the zero away would hand one runner the other's
 * row. A null number never claimed anything and so is never a roster miss.
 */
export function matchRoster(bibNumber, roster) {
  if (bibNumber == null) return null
  return roster.get(String(bibNumber)) ?? null
}

/**
 * What the stats panel shows.
 *
 * `recognitionRate` is NOT a read rate and is deliberately not called one.
 * A read rate is measured against the numbers people were actually wearing
 * and nothing here knows those. `confirm_rssi_cdbm` was set from an
 * assumption dressed as a measurement; this avoids repeating that.
 */
export function sessionStats(sightings) {
  const total = sightings.length
  const recognised = sightings.filter(s => s.bibNumber != null).length
  const rosterMatched = sightings.filter(s => s.participantId != null).length

  const framesPerTrack = Object.fromEntries(BUCKETS.map(([label]) => [label, 0]))
  let confidenceSum = 0
  for (const s of sightings) {
    const bucket = BUCKETS.find(([, lo, hi]) => s.frameCount >= lo && s.frameCount <= hi)
    if (bucket) framesPerTrack[bucket[0]] += 1
    if (s.bibNumber != null) confidenceSum += s.confidence ?? 0
  }

  return {
    total,
    recognised,
    unreadable: total - recognised,
    rosterMatched,
    // Unreadable tracks stay in the denominator. Dropping them would report
    // a camera reading one runner in ten as perfect.
    recognitionRate: total ? recognised / total : 0,
    // Measured against recognised numbers only, so it keeps meaning "when we
    // produce a number, how often is it a real one".
    rosterMatchRate: recognised ? rosterMatched / recognised : 0,
    meanConfidence: recognised ? confidenceSum / recognised : 0,
    framesPerTrack,
  }
}

/**
 * Turn the reader's health snapshot into one thing to go and fix.
 *
 * Ordered by what causes what. A dead camera makes the exposure and the
 * backlog meaningless, so it is reported alone rather than alongside its own
 * consequences.
 */
export function healthVerdict(health) {
  if (!health) {
    return {
      level: 'unknown',
      headline: 'Brak danych o kamerze',
      detail: 'Proces odczytu nie zapisał jeszcze stanu. Uruchom read_queue.py.',
    }
  }

  const heartbeatAge = health.updated_at
    ? Date.now() / 1000 - health.updated_at
    : Infinity
  if (heartbeatAge > HEARTBEAT_DEAD_AFTER_S) {
    return {
      level: 'error',
      headline: 'Proces odczytu nie odpowiada',
      detail: `Ostatni sygnał ${Math.round(heartbeatAge)} s temu. Kamera może pracować, ale nikt nie czyta klatek.`,
    }
  }
  if (health.capture_alive === false) {
    return {
      level: 'error',
      headline: 'Kamera nie dostarcza klatek',
      detail: `Ostatnia klatka ${health.last_frame_age_s ?? '?'} s temu. Sprawdź kabel, zasilanie i czy capture.py działa.`,
    }
  }
  if (health.clock_synced === false) {
    return {
      level: 'error',
      headline: 'Zegar nie jest zsynchronizowany',
      detail: 'Każdy znacznik czasu jest podejrzany. Napraw NTP przed startem.',
    }
  }
  if (health.ordering_anomalies?.length) {
    return {
      level: 'error',
      headline: 'Zegar czujnika cofnął się',
      detail: `${health.ordering_anomalies.length} skok(ów). Klatek po obu stronach skoku nie można porównać.`,
    }
  }
  if (health.exposure === 'dark') {
    return {
      level: 'warn',
      headline: 'Obraz jest za ciemny',
      detail: 'Ekspozycja jest zablokowana i wzmocnienie nie dostosowuje się samo. Zwiększ --gain.',
    }
  }
  if (health.exposure === 'bright') {
    return {
      level: 'warn',
      headline: 'Obraz jest prześwietlony',
      detail: 'Zmniejsz --gain albo skróć --exposure-us.',
    }
  }
  if (health.keeping_up === false) {
    return {
      level: 'warn',
      headline: `Odczyt nie nadąża — zaległość ${health.pending ?? 0} klatek`,
      detail: 'Podgląd jest opóźniony. Nie wpływa to na pomiar czasu, bo ten robi chip.',
    }
  }
  if (health.torn_frames > 0) {
    return {
      level: 'warn',
      headline: `${health.torn_frames} uszkodzonych klatek`,
      detail: 'Zwykle oznacza problem z zasilaniem lub dyskiem.',
    }
  }
  return { level: 'ok', headline: 'Kamera pracuje', detail: null }
}

// ─── the poller ─────────────────────────────────────────────────────────────

const timers = new Map()

async function readFrom(file, cursor) {
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    return { records: [], nextCursor: cursor }
  }
  // The log was truncated or replaced (a new session in the same directory).
  // Starting over is right; resuming past the end would skip everything.
  if (stat.size < cursor) cursor = 0
  if (stat.size === cursor) return { records: [], nextCursor: cursor }

  const chunks = []
  for await (const chunk of createReadStream(file, { start: cursor })) chunks.push(chunk)
  return parseLog(Buffer.concat(chunks), cursor)
}

async function rosterFor(db, eventId) {
  const rows = await db
    .select({ id: participants.id, bib: participants.bibNumber })
    .from(participants)
    .where(eq(participants.eventId, eventId))
  return new Map(rows.filter(r => r.bib != null).map(r => [String(r.bib), r.id]))
}

async function pollOnce(db, sessionId) {
  const [session] = await db.select().from(visionSessions)
    .where(eq(visionSessions.id, sessionId)).limit(1)
  if (!session || session.stoppedAt) return false

  // Health first: it is what the operator is watching, and it must update
  // even when no runner has crossed for ten minutes.
  let health = null
  try {
    health = JSON.parse(
      await fs.readFile(path.join(session.queueDir, 'health.json'), 'utf8'),
    )
  } catch { /* the reader has not written one yet */ }

  const { records, nextCursor } = await readFrom(
    path.join(session.queueDir, 'sightings.jsonl'), session.logCursor,
  )

  if (records.length) {
    const roster = await rosterFor(db, session.eventId)
    const rows = records.map(r => ({
      sessionId,
      bibNumber: r.bib_number ?? null,
      participantId: matchRoster(r.bib_number, roster),
      confidence: r.confidence ?? 0,
      frameCount: r.frame_count ?? 0,
      sightedAt: new Date(r.sighted_at),
      bestFrameTs: r.best_frame_ts ?? null,
      cropName: r.crop ?? null,
      votes: r.votes ?? null,
    })).filter(r => !Number.isNaN(r.sightedAt.getTime()))

    if (rows.length) {
      const inserted = await db.insert(visionSightings).values(rows)
        .onConflictDoNothing().returning()
      for (const row of inserted) broadcast('vision:sighting', row)
    }
  }

  await db.update(visionSessions)
    .set({ logCursor: nextCursor, health })
    .where(eq(visionSessions.id, sessionId))

  broadcast('vision:health', {
    sessionId, health, verdict: healthVerdict(health),
  })
  return true
}

/** Start tailing a session's files. Idempotent. */
export function startIngest(db, sessionId) {
  if (timers.has(sessionId)) return
  const timer = setInterval(() => {
    pollOnce(db, sessionId)
      .then(alive => { if (!alive) stopIngest(sessionId) })
      .catch(err => console.error('[vision] ingest', err.message))
  }, POLL_MS)
  timer.unref?.()
  timers.set(sessionId, timer)
}

export function stopIngest(sessionId) {
  const timer = timers.get(sessionId)
  if (timer) clearInterval(timer)
  timers.delete(sessionId)
}

/** Resume every session left running when the backend restarted. */
export async function resumeIngest(db) {
  const open = await db.select({ id: visionSessions.id }).from(visionSessions)
    .where(sql`${visionSessions.stoppedAt} IS NULL`)
  for (const row of open) startIngest(db, row.id)
  if (open.length) console.log(`[vision] resumed ${open.length} session(s)`)
}

export { pollOnce as _pollOnce }
