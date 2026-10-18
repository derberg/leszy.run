import { promises as fs } from 'fs'
import path from 'path'

// The window shown for one finisher, around their chip time. A runner faces
// the camera from about 3 s before the line to the moment they cross it.
export const BEFORE_MS = 3000
export const AFTER_MS = 1000
// A camera read counts as the finisher's own when the pass sits this close to
// the chip time. Further away it is the runner walking back past the gate.
export const MATCH_MS = 20000

export const VERDICTS = ['visible', 'covered', 'no_front', 'absent']

// How close a neighbouring chip finish must be to call a read its misread. At
// the 2026-10-17 race the four misreads that had a neighbour sat 0 to 1 s from
// that runner's chip finish.
export const NEIGHBOUR_MS = 2000

/** True when b is a with one digit dropped, added or changed. */
export function oneDigitApart(a, b) {
  if (a === b) return false
  if (a.length === b.length) {
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
    return diff === 1
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  if (long.length - short.length !== 1) return false
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true
  }
  return false
}

/**
 * Why a camera read is probably somebody else's number, or null.
 *
 * Every misread at the 2026-10-17 race landed on a number in the race, so the
 * roster match never caught one. Two signs did:
 * - `neighbour`: the read number has no chip finish near the pass, while a
 *   number one digit away finished within NEIGHBOUR_MS of it (12 for 112,
 *   84 for 64, 119 for 219, 136 for 138). Two runners with neighbouring
 *   numbers who finish together each have their own chip finish, so they
 *   are left alone.
 * - `dns`: the number belongs to a runner marked DNS (146, the back of 148
 *   walking out through the gate).
 * Nothing acts on this. It is shown so a person looks at the frame.
 *
 * @param {{ bibNumber: string|null, sightedAtMs: number }} sighting
 * @param {{ bibNumber: string, status: string, finishMs: number|null }[]} field
 *   every result of the event, one per runner
 */
export function likelyMisread(sighting, field) {
  const bib = sighting.bibNumber
  if (bib == null) return null
  const near = (r, ms) => r.finishMs != null && Math.abs(r.finishMs - sighting.sightedAtMs) <= ms
  const own = field.filter(r => r.bibNumber === bib)
  if (own.some(r => near(r, MATCH_MS))) return null

  let best = null
  for (const r of field) {
    if (r.bibNumber === bib || !near(r, NEIGHBOUR_MS) || !oneDigitApart(bib, r.bibNumber)) continue
    if (!best || Math.abs(r.finishMs - sighting.sightedAtMs) < Math.abs(best.finishMs - sighting.sightedAtMs)) best = r
  }
  if (best) return { reason: 'neighbour', bib: best.bibNumber }
  if (own.some(r => r.status === 'dns')) return { reason: 'dns' }
  return null
}

/**
 * Sensor timestamps (ns, as numbers) of every frame on disk, sorted.
 *
 * A race leaves tens of thousands of frames in done/, and the review screen
 * asks for one window per finisher, so the listing is cached for a minute
 * rather than read again per row.
 */
const listings = new Map()
export async function frameStamps(queueDir) {
  const hit = listings.get(queueDir)
  if (hit && Date.now() - hit.at < 60000) return hit.stamps
  const stamps = []
  for (const dir of [queueDir, path.join(queueDir, 'done')]) {
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch { /* a missing done/ is an empty one */ }
    for (const name of names) {
      const m = /^(\d{1,20})\.jpg$/.exec(name)
      if (m) stamps.push(Number(m[1]))
    }
  }
  stamps.sort((a, b) => a - b)
  listings.set(queueDir, { at: Date.now(), stamps })
  return stamps
}

/** Index of the first stamp >= target, in a sorted array. */
function lowerBound(stamps, target) {
  let lo = 0
  let hi = stamps.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stamps[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The frames around a wall-clock moment, as sensor timestamps.
 *
 * clockOffset is the session's own conversion (wall seconds = offset +
 * sensor ns / 1e9). session.json cannot be used instead: capture rewrites it
 * on every start, so after a reboot it describes a different clock.
 */
export function framesAround(stamps, clockOffset, atMs, beforeMs = BEFORE_MS, afterMs = AFTER_MS) {
  if (clockOffset == null || !stamps.length) return []
  const centre = (atMs / 1000 - clockOffset) * 1e9
  const from = lowerBound(stamps, centre - beforeMs * 1e6)
  const to = lowerBound(stamps, centre + afterMs * 1e6 + 1)
  return stamps.slice(from, to)
}

/** Body of PUT .../review/:participantId, checked. Returns { value } or { error }. */
export function parseVerdict(body) {
  const verdict = body?.verdict
  if (!VERDICTS.includes(verdict)) return { error: `verdict must be one of ${VERDICTS.join(', ')}` }
  if (verdict !== 'visible') {
    return { value: { verdict, bibNumber: null, frameTs: null, x: null, y: null } }
  }
  const bib = String(body.bibNumber ?? '').trim()
  if (!/^\d{1,4}$/.test(bib)) return { error: 'bibNumber is required for a visible bib' }
  const frameTs = Number(body.frameTs)
  const x = Number(body.x)
  const y = Number(body.y)
  if (!Number.isSafeInteger(frameTs) || frameTs < 0) return { error: 'frameTs is required for a visible bib' }
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { error: 'x and y are shares of the frame, 0 to 1' }
  return { value: { verdict, bibNumber: bib, frameTs, x, y } }
}
