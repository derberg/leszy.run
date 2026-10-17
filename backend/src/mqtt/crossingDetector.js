import { eq, and, isNotNull, asc, sql, inArray } from 'drizzle-orm'
import { checkins, gateCrossings, gateEvents, results } from '../db/schema.js'

/**
 * RFID Crossing Detection — Exit-Triggered Algorithm
 *
 * START crossings are exit-triggered: confirmed when a tag's signal disappears for
 * goneWindowMs (3 s). The confirmed timestamp is the PEAK RSSI reading — the moment
 * the runner was physically closest to the antenna. Exit-triggering is required for
 * starts because runners stand in the corral inside the read zone before the gun.
 *
 * FINISH crossings are timed at the PEAK of the pass. The first read of a
 * started runner opens a pass. Every stronger read becomes the new peak. The pass
 * closes once FINISH_QUIET_MS (2 s) go by with no stronger read, and never later
 * than FINISH_MAX_PASS_MS (6 s) after its first read, so a finisher who stops
 * under the antenna cannot keep moving their own time. Reads after the pass
 * closes never re-time the finish.
 *
 * The pass used to be a fixed 3 s window from the first read. At the 2026-10-15
 * rehearsal bib 4 was first heard 4.5 s before its peak, the window closed while
 * the runner was still walking in, and the finish came out 1.58 s early at -6450
 * instead of the -3300 read at the line. Two more runners peaked within 0.12 s of
 * that window closing.
 *
 * Finish used to be first-read: the first read above rssi_threshold WAS the
 * finish. That made rssi_threshold decide the finish time, and no value worked.
 * At the 2026-08-07 night race the floor was -6500 and every one of the 36 finish
 * peaks sat between -6000 and -6500, the histogram rising right up to the floor:
 * the floor was cutting the passes off. Three runners got no finish at all, and
 * five got one from a read minutes later, when they walked back past the gate.
 * Lowering a first-read floor only moves the finish earlier, to wherever the tag
 * is first heard. Taking the peak of the pass makes the floor harmless.
 *
 * Guard: finish reads within minFinishSeconds (per event, default 30 s) of the gun
 * are ignored — ghost reads near the start line right after the gun.
 *
 * Flow:
 *  START (participant not started yet):
 *  1. First reading → create inRange entry, arm goneTimer (3 s)
 *  2. Each subsequent reading → update peak if improved, RESET goneTimer
 *  3. goneTimer fires (3 s silence) → person left the gate → confirm crossing at peak
 *  FINISH (participant already started / finish topic, past minFinishSeconds):
 *  4. First reading → open a pass, arm a FINISH_QUIET_MS timer
 *  5. A stronger read moves the peak and re-arms the timer, capped at
 *     FINISH_MAX_PASS_MS after the first read; a weaker read changes nothing
 *  6. Timer fires → confirm at peak
 *
 * Gate determination (single-reader mode):
 *  - No startTime in DB yet → gate = 'start'
 *  - startTime already recorded → gate = 'finish'
 *  Separate-reader mode: gate determined by MQTT topic.
 *
 * Gun-time backfill (single-reader mode):
 *  After gunBackfillSeconds (default 60s, configurable per event) from race start,
 *  CHECKED-IN participants with an RFID tag who haven't been detected get gun time
 *  as their startTime (startTimeSource='gun', startTimeTrigger='auto_backfill').
 *  A runner who never checked in gets nothing: they have not accepted the
 *  regulamin and may not start, so stopping the race must leave them DNS. Gun
 *  time would make them 'started' and the stop would turn them into DNF.
 *  This ensures their next crossing is treated as finish, not a second start.
 *  Disabled per event via gunBackfillEnabled=false: neither the timer nor the
 *  finish-crossing fallback then assigns gun time — start-less runners are left
 *  for manual backfill (POST /races/:id/assign-gun-start).
 *
 * Two-tier strength gating (rssi_threshold + confirm_rssi_cdbm):
 *  - rssi_threshold is a TRACKING floor: may this read be followed at all.
 *    Default -9000, which is below anything the R700 reports, so every read is
 *    followed. With peak-of-pass timing a weak read can no longer set a time.
 *  - confirm_rssi_cdbm is a CROSSING bar: did the tag actually reach the gate.
 *    The PEAK of a start or finish pass must clear it. NULL (the default)
 *    disables it. Set it per event to stop a tag heard from far away (a runner
 *    on a stretch of course near the gate, a bib in a bag by the tent) from
 *    becoming a crossing. Measured on 2026-10-15, a runner 5 m before the
 *    antennas read -7000…-7700, so a bar near -7000 drops real passes.
 *  A start rejected by the bar falls through to gun-time backfill; a rejected
 *  finish pass leaves the runner on course, so their real pass still counts.
 *
 *  Do not raise confirm_rssi_cdbm above -6500 without a measured separation at
 *  the actual gate. Measured on 2026-08-07, runners passing right beside the
 *  antenna peaked at -6200…-6450, while others on the same pass peaked at -3200.
 *  A ~30 dB spread between identical passes is a tag-orientation/placement (or
 *  antenna-coverage) problem, not something a threshold can fix.
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
 *     Y -->|Yes| P[Open finish pass on first read · stronger read = new peak, re-arm 2s]
 *     P -->|2s with no new peak, or 6s after first read| Q{peak >= confirm bar?}
 *     Q -->|No| X
 *     Q -->|Yes| M[gate=finish · finishTime=peakTime]
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

const DEFAULT_RSSI_THRESHOLD = -9000
const DEFAULT_CONFIRM_RSSI = null
const DEFAULT_MIN_FINISH_SECONDS = 300
// A finish pass closes this long after its last new peak...
const FINISH_QUIET_MS = 2000
// ...and never later than this after its first read.
const FINISH_MAX_PASS_MS = 6000
// Statuses the gun-time backfill must never overwrite.
const SETTLED_STATUSES = new Set(['dns', 'dnf', 'dsq', 'finished'])


export class CrossingDetector {
  constructor({ db, broadcast, finishQuietMs = FINISH_QUIET_MS, finishMaxPassMs = FINISH_MAX_PASS_MS }) {
    this.db = db
    this.broadcast = broadcast
    this.finishQuietMs = finishQuietMs
    this.finishMaxPassMs = finishMaxPassMs

    // Map<raceRunId, { config, epcToParticipant, startedParticipants, finishedParticipants }>
    this.activeRaces = new Map()

    // Open passes. Start: `${epc}:${raceRunId}`, finish: `${epc}:${raceRunId}:finish`.
    // Value: { epc, raceRunId, firstAt, peakRssi, peakTime, antennaPort, topic, goneTimer }
    // A finish pass also carries peakAt: the wall-clock time of its last new peak.
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
      if (tag.raceRunId === raceRunId) {
        clearTimeout(tag.goneTimer)
        const epc = tag.epc
        const participantId = race?.epcToParticipant.get(epc)
        // Same crossing bar as the goneTimer path — otherwise stopping the race
        // would flush exactly the far-field presences the bar just rejected.
        const confirmRssi = confirmRssiOf(race?.config)
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

      // Read check-ins now, not at startRace: last-minute check-ins reach the
      // local DB through checkinSync up to 30 s later, often after the gun.
      const checkedIn = await this.#checkedInIds(missing)
      const notCheckedIn = missing.length - checkedIn.size

      let backfilled = 0
      for (const participantId of missing) {
        if (!checkedIn.has(participantId)) continue
        // Check DB to avoid overwriting a chip start that arrived between in-memory check and now
        const existing = await this.db.query.results.findFirst({
          where: and(eq(results.raceRunId, raceRunId), eq(results.participantId, participantId)),
        })
        if (existing?.startTime) {
          race.startedParticipants.add(participantId)
          continue
        }
        // A status the operator set by hand is final. A restart mid-race re-arms
        // this timer, and would otherwise turn a DNS runner back into 'started'.
        if (SETTLED_STATUSES.has(existing?.status)) continue

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

      console.log(`[Detector] Gun-time backfill for race ${raceRunId}: ${backfilled} participant(s) got gun start time (after ${gunBackfillMs / 1000}s), ${notCheckedIn} skipped as not checked in`)
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
      const rssiThreshold = race.config.rssiThreshold ?? DEFAULT_RSSI_THRESHOLD
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
      // NULL disables the bar entirely.
      const confirmRssi = confirmRssiOf(race.config)

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

      // Finish already confirmed for this runner. Audited above where still in
      // window, but later reads never re-time an existing finish.
      if (finished) continue

      const key = `${event.epc}:${raceRunId}`

      const rfidMode        = race.config.rfidMode
      const rfidTopicFinish = race.config.rfidTopicFinish
      const goneWindowMs    = (race.config.goneWindowSeconds ?? 3) * 1000
      const minFinishMs     = (race.config.minFinishSeconds ?? DEFAULT_MIN_FINISH_SECONDS) * 1000

      const isFinishRead = rfidMode === 'separate'
        ? event.topic === rfidTopicFinish
        : race.startedParticipants.has(participantId)

      if (isFinishRead) {
        // Ghost-read guard: ignore finish reads too soon after the gun
        // (runners near the start line right after the start).
        if (race.gunStartTime && (new Date(event.receivedAt) - race.gunStartTime) < minFinishMs) continue
        this.#trackFinishPass({ event, now, raceRunId, participantId, race, confirmRssi, rfidMode, rfidTopicFinish })
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
          epc:         event.epc,
          raceRunId,
          firstAt:     now,
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

  // One finish pass of one tag, timed at its peak. It closes finishQuietMs after
  // its last new peak, or finishMaxPassMs after its first read, whichever comes
  // first. Nothing is marked finished until the pass closes, so a pass rejected
  // by the crossing bar leaves the runner free to finish later.
  #trackFinishPass({ event, now, raceRunId, participantId, race, confirmRssi, rfidMode, rfidTopicFinish }) {
    const key = `${event.epc}:${raceRunId}:finish`

    const close = () => {
      const pass = this.inRange.get(key)
      if (!pass) return
      clearTimeout(pass.goneTimer)
      this.inRange.delete(key)
      if (race.finishedParticipants.has(participantId)) return
      if (confirmRssi !== null && pass.peakRssi < confirmRssi) {
        console.log(`[Detector] Discarding finish pass for ${event.epc} in race ${raceRunId}: peak ${pass.peakRssi} never reached confirm bar ${confirmRssi}`)
        return
      }
      // Mark finished synchronously BEFORE the async confirm, so reads arriving
      // during the DB round trip cannot open a second pass.
      race.finishedParticipants.add(participantId)
      // Keep auditing this tag for a short window so the tail of the pass lands
      // in gate_events too.
      race.finishAuditUntil.set(participantId, Date.now() + FINISH_AUDIT_WINDOW_MS)
      this.#confirmCrossing({
        raceRunId,
        participantId,
        peakRssi: pass.peakRssi,
        peakTime: pass.peakTime,
        antennaPort: pass.antennaPort,
        topic: pass.topic,
        rfidMode,
        rfidTopicFinish,
        race,
      })
    }

    let pass = this.inRange.get(key)
    if (pass && (now - pass.firstAt >= this.finishMaxPassMs || now - pass.peakAt >= this.finishQuietMs)) {
      // The timer is due but has not run yet: this read is after the pass.
      close()
      return
    }
    if (!pass) {
      pass = { epc: event.epc, raceRunId, firstAt: now, peakAt: now, peakRssi: -Infinity, peakTime: null, antennaPort: null, topic: null, goneTimer: null }
      this.inRange.set(key, pass)
    }
    if (event.rssiCdbm > pass.peakRssi) {
      pass.peakRssi    = event.rssiCdbm
      pass.peakTime    = new Date(event.receivedAt)
      pass.antennaPort = event.antennaPort
      pass.topic       = event.topic
      pass.peakAt      = now
      clearTimeout(pass.goneTimer)
      const untilCap = this.finishMaxPassMs - (now - pass.firstAt)
      pass.goneTimer = setTimeout(close, Math.min(this.finishQuietMs, untilCap))
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
        const minFinishMs = (race.config?.minFinishSeconds ?? DEFAULT_MIN_FINISH_SECONDS) * 1000
        const elapsed = peakTime - race.gunStartTime
        if (elapsed < minFinishMs) {
          // Roll back the optimistic finished mark so the real crossing still counts
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
        // The same holds for a runner who never checked in: they may not start, so
        // they are never credited with gun time either.
        const backfillGun = noChipStart && race?.config?.gunBackfillEnabled !== false
          && (await this.#checkedInIds([participantId])).has(participantId)

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

  /** @returns {Promise<Set<string>>} the ids among `participantIds` with a check-in */
  async #checkedInIds(participantIds) {
    if (!participantIds.length) return new Set()
    const rows = await this.db
      .select({ participantId: checkins.participantId })
      .from(checkins)
      .where(and(inArray(checkins.participantId, participantIds), isNotNull(checkins.checkedInAt)))
    return new Set(rows.map(r => r.participantId))
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

// A missing value means the default, which is no bar.
function confirmRssiOf(config) {
  if (!config || config.confirmRssiCdbm === undefined) return DEFAULT_CONFIRM_RSSI
  return config.confirmRssiCdbm
}
