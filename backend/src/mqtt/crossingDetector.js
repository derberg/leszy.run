import { eq, and, isNotNull, asc, sql } from 'drizzle-orm'
import { gateCrossings, gateEvents, results } from '../db/schema.js'

/**
 * RFID Crossing Detection — Exit-Triggered Algorithm
 *
 * START crossings are exit-triggered: confirmed when a tag's signal disappears for
 * goneWindowMs (3 s). The confirmed timestamp is the PEAK RSSI reading — the moment
 * the runner was physically closest to the antenna. Exit-triggering is required for
 * starts because runners stand in the corral inside the read zone before the gun.
 *
 * FINISH crossings are first-read: the FIRST reading above the event's rssi_threshold
 * from an already-started participant confirms the finish immediately with that
 * reading's timestamp. No timers, no waiting — subsequent readings are ignored via
 * finishedParticipants. (The old fallbackSeconds maxTimer is gone: with sensitive
 * tags it fired during the far-field approach, recording a weak early "finish" and
 * then ignoring the real crossing.)
 *
 * Guard: finish reads within minFinishSeconds (per event, default 30 s) of the gun
 * are ignored — ghost reads near the start line right after the gun.
 *
 * Flow:
 *  START (participant not started yet):
 *  1. First reading → create inRange entry, arm goneTimer (3 s)
 *  2. Each subsequent reading → update peak if improved, RESET goneTimer
 *  3. goneTimer fires (3 s silence) → person left the gate → confirm crossing at peak
 *  FINISH (participant already started / finish topic):
 *  4. First reading above threshold (and past minFinishSeconds) → confirm immediately
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
 *  Disabled per event via gunBackfillEnabled=false: neither the timer nor the
 *  finish-crossing fallback then assigns gun time — start-less runners are left
 *  for manual backfill (POST /races/:id/assign-gun-start).
 *
 * Peak RSSI: values closer to 0 are stronger. -2000 cdbm > -6000 cdbm.
 *
 * ```mermaid
 * flowchart TD
 *     A[RFID event received] --> T{rssi >= threshold?}
 *     T -->|No| X[Ignore]
 *     T -->|Yes| B{Participant already started?}
 *     B -->|Yes / finish topic| Y{Past minFinishSeconds since gun?}
 *     Y -->|No| X
 *     Y -->|Yes| M[gate=finish · finishTime=this reading · confirm IMMEDIATELY]
 *     M --> O[broadcast · persist · add to finishedParticipants · ignore further reads]
 *     B -->|No| C{Tag in inRange map?}
 *     C -->|No| D[Create entry · arm goneTimer 3s]
 *     C -->|Yes| E{rssi > peakRssi?}
 *     E -->|Yes| F[Update peak]
 *     E -->|No| G[Keep tracking]
 *     F --> H[Reset goneTimer]
 *     G --> H
 *     D --> H
 *     H -->|next reading| A
 *     H -->|3s silence| I[goneTimer fires · confirmCrossing at peakTime]
 *     I --> L[gate=start · startTime=peakTime]
 *     L --> N[broadcast · persist · add to startedParticipants]
 * ```
 */

const DEDUP_WINDOW_MS = 200   // within this window per EPC, only keep best RSSI


export class CrossingDetector {
  constructor({ db, broadcast }) {
    this.db = db
    this.broadcast = broadcast

    // Map<raceRunId, { config, epcToParticipant, startedParticipants, finishedParticipants }>
    this.activeRaces = new Map()

    // Map<`${epc}:${raceRunId}`, { peakRssi, peakTime, antennaPort, topic, goneTimer }>
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

    // Pre-populate from DB so first-read finish detection works after a backend restart
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
    // Skipped entirely when auto-backfill is disabled for the event (gunBackfillEnabled === false):
    // start-less runners then never get an automatic gun start time and are left for manual backfill.
    if (eventConfig.gunBackfillEnabled === false) {
      console.log(`[Detector] Gun-time backfill disabled for race ${raceRun.id}`)
    } else {
      const gunBackfillMs = (eventConfig.gunBackfillSeconds ?? 60) * 1000
      this.#scheduleGunTimeBackfill(raceRun.id, gunStartTime, epcMap, startedParticipants, gunBackfillMs)
    }
  }

  async stopRace(raceRunId) {
    // Force-confirm any pending inRange entries before clearing them
    const pendingConfirms = []
    const race = this.activeRaces.get(raceRunId)
    for (const [key, tag] of this.inRange) {
      if (key.endsWith(`:${raceRunId}`)) {
        clearTimeout(tag.goneTimer)
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

      console.log(`[Detector] Gun-time backfill for race ${raceRunId}: ${backfilled} participant(s) got gun start time (after ${gunBackfillMs / 1000}s)`)
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

      const rfidMode        = race.config.rfidMode
      const rfidTopicFinish = race.config.rfidTopicFinish
      const goneWindowMs    = (race.config.goneWindowSeconds ?? 3) * 1000
      const minFinishMs     = (race.config.minFinishSeconds ?? 30) * 1000

      // FINISH is first-read: the first above-threshold reading from a started
      // participant IS the finish. No exit-triggering — with sensitive tags the
      // old fallback timer confirmed "finishes" during the far-field approach.
      const isFinishRead = rfidMode === 'separate'
        ? event.topic === rfidTopicFinish
        : race.startedParticipants.has(participantId)

      if (isFinishRead) {
        // Ghost-read guard: ignore finish reads too soon after the gun
        // (runners near the start line right after the start).
        if (race.gunStartTime && (new Date(event.receivedAt) - race.gunStartTime) < minFinishMs) continue
        // Mark finished synchronously BEFORE the async confirm — readings arrive
        // faster than the DB roundtrip and would otherwise double-confirm.
        race.finishedParticipants.add(participantId)
        this.#confirmCrossing({
          raceRunId,
          participantId,
          peakRssi: event.rssiCdbm,
          peakTime: new Date(event.receivedAt),
          antennaPort: event.antennaPort,
          topic: event.topic,
          rfidMode,
          rfidTopicFinish,
          race,
        })
        continue
      }

      // START is exit-triggered: track presence, confirm at peak after silence
      const tag = this.inRange.get(key)

      const doConfirm = (t) => {
        clearTimeout(t.goneTimer)
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
        // First reading: create entry, arm gone timer
        const newTag = {
          peakRssi:    event.rssiCdbm,
          peakTime:    new Date(event.receivedAt),
          antennaPort: event.antennaPort,
          topic:       event.topic,
          goneTimer:   null,
        }
        armGoneTimer(newTag)
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

      // Guard: ignore finish crossings too soon after race start (ghost reads from
      // tags still near the antenna right after the gun). Per-event configurable.
      if (gate === 'finish' && race?.gunStartTime) {
        const minFinishMs = (race.config?.minFinishSeconds ?? 30) * 1000
        const elapsed = peakTime - race.gunStartTime
        if (elapsed < minFinishMs) {
          // Roll back the optimistic first-read mark so the real crossing still counts
          race.finishedParticipants.delete(participantId)
          console.log(`[Detector] Ignoring finish crossing for ${participantId} — only ${Math.round(elapsed / 1000)}s since race start (min ${minFinishMs / 1000}s)`)
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
        // When auto-backfill is disabled we never credit a start-less runner with gun time,
        // not even here at the finish read: record the raw finish but leave start + both
        // durations empty so an operator resolves it via manual backfill. Runners with a
        // real chip start are unaffected — they keep their netto (durationMs) and brutto
        // (gunDurationMs) times exactly as before.
        const backfillGun = noChipStart && race?.config?.gunBackfillEnabled !== false

        // Build the set fields (never include raceRunId/participantId — those are the conflict target)
        const setFields = {
          finishTime: peakTime,
          durationMs: noChipStart ? (backfillGun ? gunDurationMs : null) : durationMs,
          gunDurationMs: noChipStart && !backfillGun ? null : gunDurationMs,
          status: 'finished',
          finishCrossingId: crossing.id,
          ...(backfillGun && {
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
