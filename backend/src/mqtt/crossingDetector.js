import { eq, and, isNotNull, asc, sql } from 'drizzle-orm'
import { gateCrossings, gateEvents, results } from '../db/schema.js'

/**
 * RFID Crossing Detection — Exit-Triggered Algorithm
 *
 * A crossing is confirmed when a tag's signal disappears for goneWindowMs (3 s).
 * The confirmed timestamp is always the PEAK RSSI reading — the moment the runner
 * was physically closest to the antenna.
 *
 * Flow:
 *  1. First reading → create inRange entry, arm goneTimer (3 s) + maxTimer (fallbackSeconds)
 *  2. Each subsequent reading → update peak if improved, RESET goneTimer
 *  3. goneTimer fires (3 s silence) → person left the gate → confirm crossing
 *  4. maxTimer fires (fallbackSeconds, never resets) → person still at gate → force-confirm
 *
 * Gate determination (single-reader mode):
 *  - No startTime in DB yet → gate = 'start'
 *  - startTime already recorded → gate = 'finish'
 *  Separate-reader mode: gate determined by MQTT topic.
 *
 * Gun-time backfill (single-reader mode):
 *  After gunBackfillSeconds (default 60s, configurable per event) from race start,
 *  participants with an RFID tag who haven't been detected get gun time as their
 *  startTime (startTimeSource='gun', startTimeTrigger='auto_backfill').
 *  This ensures their next crossing is treated as finish, not a second start.
 *
 * Peak RSSI: values closer to 0 are stronger. -2000 cdbm > -6000 cdbm.
 *
 * ```mermaid
 * flowchart TD
 *     A[RFID event received] --> C{Tag in inRange map?}
 *     C -->|No| D[Create entry · arm goneTimer 3s · arm maxTimer fallbackSeconds]
 *     C -->|Yes| E{rssi > peakRssi?}
 *     E -->|Yes| F[Update peak]
 *     E -->|No| G[Keep tracking]
 *     F --> H[Reset goneTimer]
 *     G --> H
 *     D --> H
 *     H -->|next reading| A
 *     H -->|3s silence| I[goneTimer fires · confirmCrossing at peakTime]
 *     H -->|fallbackSeconds| J[maxTimer fires · confirmCrossing at peakTime]
 *     I --> K{startTime in DB?}
 *     J --> K
 *     K -->|No| L[gate=start · startTime=peakTime]
 *     K -->|Yes| M[gate=finish · finishTime=peakTime · durationMs]
 *     L --> N[broadcast · persist · add to startedParticipants]
 *     M --> O[broadcast · persist · add to finishedParticipants]
 * ```
 */

const DEDUP_WINDOW_MS = 200   // within this window per EPC, only keep best RSSI
const MIN_FINISH_MS = 30_000  // ignore finish crossings within 30s of race start (ghost reads from previous run)


export class CrossingDetector {
  constructor({ db, broadcast }) {
    this.db = db
    this.broadcast = broadcast

    // Map<raceRunId, { config, epcToParticipant, startedParticipants, finishedParticipants }>
    this.activeRaces = new Map()

    // Map<`${epc}:${raceRunId}`, { peakRssi, peakTime, antennaPort, topic, goneTimer, maxTimer }>
    this.inRange = new Map()

    // Dedup window: Map<epc, { rssi, time }>
    this.recentWindow = new Map()

    // Map<raceRunId, timerId> — gun-time backfill timers, cleared on stopRace
    this.backfillTimers = new Map()
  }

  async startRace(raceRun, eventConfig, participantList) {
    const epcMap = new Map()
    for (const p of participantList) {
      if (p.rfidEpc) epcMap.set(p.rfidEpc, p.id)
    }

    // Pre-populate from DB so maxTimer arms correctly after a backend restart
    const existingResults = await this.db
      .select({ participantId: results.participantId, startTime: results.startTime, finishTime: results.finishTime })
      .from(results)
      .where(eq(results.raceRunId, raceRun.id))

    const startedParticipants = new Set()
    const finishedParticipants = new Set()
    for (const r of existingResults) {
      if (r.startTime)  startedParticipants.add(r.participantId)
      if (r.finishTime) finishedParticipants.add(r.participantId)
    }

    const gunStartTime = raceRun.startedAt ? new Date(raceRun.startedAt) : new Date()

    this.activeRaces.set(raceRun.id, {
      config: eventConfig,
      gunStartTime,
      epcToParticipant: epcMap,
      startedParticipants,
      finishedParticipants,
    })
    console.log(`[Detector] Started race ${raceRun.id} with ${epcMap.size} tagged participants (${startedParticipants.size} already started, ${finishedParticipants.size} already finished)`)

    // After gunBackfillSeconds, backfill gun time for checked-in participants whose chip start was not detected.
    // In single-reader mode this ensures their next crossing is treated as finish, not start.
    const gunBackfillMs = (eventConfig.gunBackfillSeconds ?? 60) * 1000
    this.#scheduleGunTimeBackfill(raceRun.id, gunStartTime, epcMap, startedParticipants, gunBackfillMs)
  }

  async stopRace(raceRunId) {
    // Force-confirm any pending inRange entries before clearing them
    const pendingConfirms = []
    const race = this.activeRaces.get(raceRunId)
    for (const [key, tag] of this.inRange) {
      if (key.endsWith(`:${raceRunId}`)) {
        clearTimeout(tag.goneTimer)
        clearTimeout(tag.maxTimer)
        const epc = key.split(':')[0]
        const participantId = race?.epcToParticipant.get(epc)
        if (participantId && race && !race.finishedParticipants.has(participantId)) {
          pendingConfirms.push(
            this.#confirmCrossing({
              raceRunId,
              participantId,
              peakRssi: tag.peakRssi,
              peakTime: tag.peakTime,
              antennaPort: tag.antennaPort,
              topic: tag.topic,
              rfidMode: race.config.rfidMode,
              rfidTopicFinish: race.config.rfidTopicFinish,
              race,
            }).catch(err => console.error(`[Detector] Failed to flush pending crossing for ${epc}:`, err))
          )
        }
        this.inRange.delete(key)
      }
    }
    if (pendingConfirms.length) {
      await Promise.all(pendingConfirms)
      console.log(`[Detector] Flushed ${pendingConfirms.length} pending crossing(s) on race stop`)
    }
    this.activeRaces.delete(raceRunId)
    const backfillTimer = this.backfillTimers.get(raceRunId)
    if (backfillTimer) {
      clearTimeout(backfillTimer)
      this.backfillTimers.delete(raceRunId)
    }
    console.log(`[Detector] Stopped race ${raceRunId}`)
  }

  #scheduleGunTimeBackfill(raceRunId, gunStartTime, epcMap, startedParticipants, gunBackfillMs) {
    const timerId = setTimeout(async () => {
      this.backfillTimers.delete(raceRunId)
      const race = this.activeRaces.get(raceRunId)
      if (!race) return // race was stopped before timer fired

      // Find participants with an EPC who haven't started yet AND are not currently
      // in the detection zone (inRange). Tags in range will get a proper chip start
      // once they move away and the goneTimer fires — backfilling them now would
      // corrupt gate detection (their first crossing would be treated as finish).
      const missing = []
      for (const [epc, participantId] of epcMap) {
        if (race.startedParticipants.has(participantId)) continue
        const key = `${epc}:${raceRunId}`
        if (this.inRange.has(key)) continue
        missing.push(participantId)
      }
      if (!missing.length) return

      let backfilled = 0
      for (const participantId of missing) {
        // Check DB to avoid overwriting a chip start that arrived between in-memory check and now
        const existing = await this.db.query.results.findFirst({
          where: and(eq(results.raceRunId, raceRunId), eq(results.participantId, participantId)),
        })
        if (existing?.startTime) {
          race.startedParticipants.add(participantId)
          continue
        }

        await this.db.insert(results).values({
          raceRunId,
          participantId,
          startTime: gunStartTime,
          status: 'started',
          startTimeSource: 'gun',
          startTimeTrigger: 'auto_backfill',
        }).onConflictDoUpdate({
          target: [results.raceRunId, results.participantId],
          set: { startTime: gunStartTime, status: 'started', startTimeSource: 'gun', startTimeTrigger: 'auto_backfill' },
        })
        race.startedParticipants.add(participantId)
        backfilled++
      }

      // Arm maxTimer retroactively for participants already in range before backfill.
      // Without this, participants who arrive at the finish gate before backfill runs
      // never get a maxTimer (it's only armed on first ping if already in startedParticipants),
      // so their crossing is delayed until they physically walk away from the antenna.
      const fallbackMs = (race.config.fallbackSeconds ?? 10) * 1000
      let retroArmed = 0
      for (const [epc, participantId] of epcMap) {
        const key = `${epc}:${raceRunId}`
        const tag = this.inRange.get(key)
        if (!tag || tag.maxTimer) continue
        if (!race.startedParticipants.has(participantId)) continue
        if (race.finishedParticipants.has(participantId)) continue

        tag.maxTimer = setTimeout(() => {
          const current = this.inRange.get(key)
          if (!current) return
          clearTimeout(current.goneTimer)
          clearTimeout(current.maxTimer)
          this.inRange.delete(key)
          this.#confirmCrossing({
            raceRunId,
            participantId,
            peakRssi: current.peakRssi,
            peakTime: current.peakTime,
            antennaPort: current.antennaPort,
            topic: current.topic,
            rfidMode: race.config.rfidMode,
            rfidTopicFinish: race.config.rfidTopicFinish,
            race,
          })
        }, fallbackMs)
        retroArmed++
      }

      console.log(`[Detector] Gun-time backfill for race ${raceRunId}: ${backfilled} participant(s) got gun start time (after ${gunBackfillMs / 1000}s)${retroArmed ? `, ${retroArmed} maxTimer(s) retroactively armed` : ''}`)
    }, gunBackfillMs)

    this.backfillTimers.set(raceRunId, timerId)
  }

  processEvent(event) {
    const now = Date.now()

    // Dedup: within DEDUP_WINDOW_MS, skip if not improving on the best RSSI seen
    const win = this.recentWindow.get(event.epc)
    if (win && (now - win.time) < DEDUP_WINDOW_MS) {
      if (event.rssiCdbm <= win.rssi) return
    }
    this.recentWindow.set(event.epc, { rssi: event.rssiCdbm, time: now })

    // Broadcast raw event for live feed
    this.broadcast('rfid:raw', {
      epc: event.epc,
      rssi: event.rssiCdbm,
      antennaPort: event.antennaPort,
      topic: event.topic,
      receivedAt: event.receivedAt,
    })

    for (const [raceRunId, race] of this.activeRaces) {
      const participantId = race.epcToParticipant.get(event.epc)
      if (!participantId) continue
      if (race.finishedParticipants.has(participantId)) continue

      // Readings weaker than the event's rssi_threshold are far-field noise
      // (high-sensitivity tags read from 20+ m) — not a gate crossing. Skip
      // detection AND the audit insert; sub-threshold reads also must not
      // reset goneTimer, so a runner leaving the gate zone confirms promptly.
      const rssiThreshold = race.config.rssiThreshold ?? -5000
      if (event.rssiCdbm < rssiThreshold) continue

      // Persist raw ping for audit — fire-and-forget, must not block sync detection loop
      this.db.insert(gateEvents).values({
        raceRunId,
        epc:         event.epc,
        antennaPort: event.antennaPort,
        rssiCdbm:    event.rssiCdbm,
        frequency:   event.frequency ?? null,
        topic:       event.topic,
        receivedAt:  new Date(event.receivedAt),
        raw:         event.raw,
      }).catch(err => console.error('[Detector] Failed to persist gate event:', err))

      const key = `${event.epc}:${raceRunId}`
      const tag = this.inRange.get(key)

      const rfidMode        = race.config.rfidMode
      const rfidTopicFinish = race.config.rfidTopicFinish
      const goneWindowMs    = (race.config.goneWindowSeconds ?? 3) * 1000
      const fallbackMs      = (race.config.fallbackSeconds ?? 10) * 1000

      const doConfirm = (t) => {
        clearTimeout(t.goneTimer)
        clearTimeout(t.maxTimer)
        this.inRange.delete(key)
        this.#confirmCrossing({
          raceRunId,
          participantId,
          peakRssi: t.peakRssi,
          peakTime: t.peakTime,
          antennaPort: t.antennaPort,
          topic: t.topic,
          rfidMode,
          rfidTopicFinish,
          race,
        })
      }

      const armGoneTimer = (t) => {
        clearTimeout(t.goneTimer)
        t.goneTimer = setTimeout(() => {
          const current = this.inRange.get(key)
          if (!current) return
          doConfirm(current)
        }, goneWindowMs)
      }

      if (!tag) {
        // First reading: create entry, arm timers
        const newTag = {
          peakRssi:    event.rssiCdbm,
          peakTime:    new Date(event.receivedAt),
          antennaPort: event.antennaPort,
          topic:       event.topic,
          goneTimer:   null,
          maxTimer:    null,
        }
        armGoneTimer(newTag)
        // maxTimer (force-confirm) only for finish crossings — runner may collapse at finish line
        if (race.startedParticipants.has(participantId)) {
          newTag.maxTimer = setTimeout(() => {
            const current = this.inRange.get(key)
            if (!current) return
            doConfirm(current)
          }, fallbackMs)
        }
        this.inRange.set(key, newTag)

      } else {
        // Tag still in range: update peak if improved, reset gone timer
        if (event.rssiCdbm > tag.peakRssi) {
          tag.peakRssi    = event.rssiCdbm
          tag.peakTime    = new Date(event.receivedAt)
          tag.antennaPort = event.antennaPort
          tag.topic       = event.topic
        }
        armGoneTimer(tag)
        // maxTimer keeps running untouched
      }
    }
  }

  async #confirmCrossing({ raceRunId, participantId, peakRssi, peakTime, antennaPort, topic, rfidMode, rfidTopicFinish, race }) {
    try {
      const db = this.db

      // Determine gate
      let gate
      if (rfidMode === 'separate') {
        gate = topic === rfidTopicFinish ? 'finish' : 'start'
      } else {
        // Single-reader: check in-memory startedParticipants first (fast path),
        // fall back to DB for races restored after a restart
        if (race && race.startedParticipants.has(participantId)) {
          gate = 'finish'
        } else {
          const existing = await db.query.results.findFirst({
            where: and(eq(results.raceRunId, raceRunId), eq(results.participantId, participantId)),
          })
          gate = (!existing || !existing.startTime) ? 'start' : 'finish'
        }
      }

      // Guard: if finish crossing happens too soon after race start, demote to start.
      // This catches ghost reads from tags still near the antenna after a race restart.
      if (gate === 'finish' && race?.gunStartTime) {
        const elapsed = peakTime - race.gunStartTime
        if (elapsed < MIN_FINISH_MS) {
          console.log(`[Detector] Ignoring finish crossing for ${participantId} — only ${Math.round(elapsed / 1000)}s since race start (min ${MIN_FINISH_MS / 1000}s)`)
          return
        }
      }

      // Count existing crossings
      const [{ count }] = await db
        .select({ count: sql`count(*)` })
        .from(gateCrossings)
        .where(and(eq(gateCrossings.raceRunId, raceRunId), eq(gateCrossings.participantId, participantId)))

      const crossingNumber = Number(count) + 1

      const [crossing] = await db.insert(gateCrossings).values({
        raceRunId,
        participantId,
        gate,
        crossingNumber,
        confirmedAt: peakTime,
        peakRssiCdbm: peakRssi,
        antennaPort,
      }).returning()

      if (gate === 'start') {
        await db.insert(results).values({
          raceRunId,
          participantId,
          startTime: peakTime,
          status: 'started',
          startCrossingId: crossing.id,
          startTimeSource: 'chip',
        }).onConflictDoUpdate({
          target: [results.raceRunId, results.participantId],
          set: { startTime: peakTime, status: 'started', startCrossingId: crossing.id, startTimeSource: 'chip' },
        })
        if (race) race.startedParticipants.add(participantId)

      } else {
        const existing = await db.query.results.findFirst({
          where: and(eq(results.raceRunId, raceRunId), eq(results.participantId, participantId)),
        })
        const durationMs = existing?.startTime ? peakTime - new Date(existing.startTime) : null
        const gunDurationMs = race?.gunStartTime ? peakTime - race.gunStartTime : null
        const noChipStart = !existing?.startTime

        // Build the set fields (never include raceRunId/participantId — those are the conflict target)
        const setFields = {
          finishTime: peakTime,
          durationMs: noChipStart ? gunDurationMs : durationMs,
          gunDurationMs,
          status: 'finished',
          finishCrossingId: crossing.id,
          ...(noChipStart && {
            startTime: race.gunStartTime,
            startTimeSource: 'gun',
            startTimeTrigger: 'finish_crossing',
          }),
        }

        await db.insert(results).values({
          raceRunId,
          participantId,
          ...setFields,
        }).onConflictDoUpdate({
          target: [results.raceRunId, results.participantId],
          set: setFields,
        })

        await this.#recalcPositions(raceRunId)

        if (noChipStart && race) {
          race.startedParticipants.add(participantId)
        }
        if (race) race.finishedParticipants.add(participantId)
      }

      this.broadcast('rfid:crossing', {
        raceRunId,
        participantId,
        gate,
        crossingNumber,
        confirmedAt: peakTime,
        peakRssiCdbm: peakRssi,
      })

      const updatedResult = await db.query.results.findFirst({
        where: and(eq(results.raceRunId, raceRunId), eq(results.participantId, participantId)),
      })
      if (updatedResult) this.broadcast('result:update', updatedResult)

      console.log(`[Detector] Crossing confirmed: participant=${participantId} gate=${gate} peakRssi=${peakRssi} at=${peakTime.toISOString()}`)
    } catch (err) {
      console.error('[Detector] Error confirming crossing:', err)
    }
  }

  async #recalcPositions(raceRunId) {
    const finished = await this.db
      .select({ id: results.id })
      .from(results)
      .where(and(eq(results.raceRunId, raceRunId), isNotNull(results.finishTime)))
      .orderBy(asc(results.gunDurationMs))

    for (let i = 0; i < finished.length; i++) {
      await this.db.update(results).set({ position: i + 1 }).where(eq(results.id, finished[i].id))
    }
  }
}
