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
 * Two-tier strength gating (rssi_threshold + confirm_rssi_cdbm):
 *  - rssi_threshold is a TRACKING floor — may this read be followed at all.
 *    Must stay permissive or weak-but-real tags are never seen.
 *  - confirm_rssi_cdbm is a CROSSING bar — did the tag actually reach the gate.
 *    START requires the accumulated PEAK to clear it; FINISH requires the
 *    individual read to clear it. NULL disables it (single-threshold behaviour).
 *  A start rejected by the bar falls through to gun-time backfill.
 *
 *  KEEP confirm_rssi_cdbm NULL UNLESS A CLEAN SEPARATION HAS BEEN MEASURED AT
 *  THE ACTUAL GATE. It was designed on the belief that a real pass is always
 *  strong (-3200…-5000) and only far-field pickup is weak, so ~-5500 would split
 *  them. Measured on 2026-08-07 that is FALSE: runners passing right beside the
 *  antenna peaked at -6200…-6450, while others on the same pass peaked at -3200.
 *  A ~30 dB spread between identical passes is a tag-orientation/placement (or
 *  antenna-coverage) problem, not something a threshold can fix — a bar set on
 *  the wrong assumption silently discards genuine crossings.
 *  gate_crossings.peak_rssi_cdbm records every confirmed crossing's peak, so
 *  weak crossings can be reviewed AFTER a race instead of dropped during it.
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
// After a finish is confirmed, keep writing that tag's reads to gate_events for this
// long so the whole finish pass is auditable (how many reads, how strong) instead of
// just the single read that happened to confirm it. Bounded so a finisher loitering
// near the gate doesn't fill the table.
//
// Sized off the approach, not the crossing: the first read fires from roughly 8 m out
// (measured 2026-08-07 — real crossings at -60..-65 dBm vs -71..-78 for a tag 15-20 m
// away), so the window has to cover the walk-in from there. A runner at 3 m/s needs
// ~2.7 s, but a Nordic walker at ~1.4 m/s needs ~5.7 s — and that slow, weak-signal
// group is exactly who this audit exists for, so a 5 s window would clip the very
// passes worth inspecting. 10 s covers the slowest finisher with margin.
const FINISH_AUDIT_WINDOW_MS = 10_000


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
      // participantId -> epoch ms until which post-finish reads are still persisted
      // to gate_events (see FINISH_AUDIT_WINDOW_MS). Empty after a restart, which is
      // fine: it only costs audit rows for runners who finished before the restart.
      finishAuditUntil: new Map(),
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
        // Same crossing bar as the goneTimer path — otherwise stopping the race
        // would flush exactly the far-field presences the bar just rejected.
        const confirmRssi = race?.config?.confirmRssiCdbm ?? null
        const tooWeak = confirmRssi !== null && tag.peakRssi < confirmRssi
        if (tooWeak) {
          console.log(`[Detector] Dropping pending far-field presence for ${epc} on stop — peak ${tag.peakRssi} < confirm bar ${confirmRssi}`)
        }
        if (participantId && race && !tooWeak && !race.finishedParticipants.has(participantId)) {
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

      // Readings weaker than the event's rssi_threshold are far-field noise
      // (high-sensitivity tags read from 20+ m) — not a gate crossing. Skip
      // detection AND the audit insert; sub-threshold reads also must not
      // reset goneTimer, so a runner leaving the gate zone confirms promptly.
      const rssiThreshold = race.config.rssiThreshold ?? -6500
      if (event.rssiCdbm < rssiThreshold) continue

      // TWO-TIER STRENGTH GATING.
      //
      // rssiThreshold above is a TRACKING floor: it decides whether a read is
      // worth following at all, and must stay permissive or a weak-but-real tag
      // is never seen (at -5000 only 8 of 20 runners were detected at a real
      // start line; at -6500, 19 of 20 were).
      //
      // confirmRssiCdbm is a CROSSING bar: it decides whether a tag actually came
      // close enough to the antenna to have crossed the gate. A permissive floor
      // alone means a tag idling 15 m away — above the floor, never near the gate
      // — accumulates readings, goes quiet, and is recorded as a crossing at a
      // time when the runner was nowhere near the line.
      //
      // One number cannot do both jobs: tag performance spans ~30 dB, so any
      // single value trades missed runners against phantom crossings. Real gate
      // passes peak at -3200…-5000; far-field loiterers top out around -6200.
      //
      // NULL disables the bar entirely (pre-existing behaviour).
      const confirmRssi = race.config.confirmRssiCdbm ?? null

      // Persist raw ping for audit — fire-and-forget, must not block sync detection loop.
      //
      // The finishedParticipants short-circuit used to sit ABOVE this insert, which
      // meant a finish pass recorded exactly ONE gate event: the first read confirms
      // the finish, every later read of the same pass was dropped un-persisted. After
      // the 2026-08-07 race there was therefore no way to tell whether a finish was a
      // solid 20-read crossing or one lucky ping at the noise floor — the single most
      // useful thing to know when tuning a gate. Now post-finish reads keep landing in
      // gate_events for FINISH_AUDIT_WINDOW_MS, long enough to capture the rest of the
      // pass but not the runner standing around chatting for the next half hour (which
      // on a sensitive tag would be thousands of rows per finisher).
      const finished = race.finishedParticipants.has(participantId)
      const auditUntil = race.finishAuditUntil.get(participantId)
      if (!finished || (auditUntil !== undefined && now < auditUntil)) {
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
      }

      // Finish already confirmed for this runner — audited above where still in
      // window, but no further detection work (first-read finish semantics: later
      // reads never re-time an existing finish).
      if (finished) continue

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
        // FINISH is first-read, so the crossing bar applies to THIS read rather
        // than an accumulated peak. Skipping (instead of buffering) keeps the
        // first-read semantics intact: the first read strong enough to be a real
        // gate pass is the finish. Critically this must NOT add the participant
        // to finishedParticipants — doing so would swallow their real crossing
        // moments later and leave them permanently unfinished.
        if (confirmRssi !== null && event.rssiCdbm < confirmRssi) continue
        // Mark finished synchronously BEFORE the async confirm — readings arrive
        // faster than the DB roundtrip and would otherwise double-confirm.
        race.finishedParticipants.add(participantId)
        // Keep auditing this tag for a short window so the REST of the finish pass
        // lands in gate_events — that is what makes "was this a solid crossing or
        // one lucky ping?" answerable after the race.
        race.finishAuditUntil.set(participantId, now + FINISH_AUDIT_WINDOW_MS)
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
        // The tag went quiet, but if its PEAK never cleared the crossing bar it
        // was never at the gate — drop it instead of recording a start at a time
        // the runner wasn't there. A start-less runner is then picked up by
        // gun-time backfill (or manual assignment), which is a far better outcome
        // than a confidently wrong chip time corrupting their net result.
        if (confirmRssi !== null && t.peakRssi < confirmRssi) {
          console.log(`[Detector] Discarding far-field presence for ${event.epc} in race ${raceRunId} — peak ${t.peakRssi} never reached confirm bar ${confirmRssi}`)
          return
        }
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
          race.finishAuditUntil.delete(participantId)
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
