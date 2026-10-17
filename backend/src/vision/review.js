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
