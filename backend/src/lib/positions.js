import { eq } from 'drizzle-orm'
import { results } from '../db/schema.js'

// A DNS, DNF or DSQ runner can still hold a finish time (a DSQ is usually
// decided after the runner crossed the line), but none of them places.
export const UNRANKED = new Set(['dns', 'dnf', 'dsq'])

/**
 * Positions for one race run: finishers by brutto time, everyone else null.
 * @param {{ id: string, finishTime: Date|string|null, gunDurationMs: number|null, status: string }[]} rows
 * @returns {Map<string, number|null>} result id → position
 */
export function rankFinishers(rows) {
  const ranked = rows
    .filter(r => r.finishTime && !UNRANKED.has(r.status))
    .sort((a, b) => (a.gunDurationMs ?? Infinity) - (b.gunDurationMs ?? Infinity))
  const positions = new Map(rows.map(r => [r.id, null]))
  ranked.forEach((r, i) => positions.set(r.id, i + 1))
  return positions
}

/** Rewrites `position` on every result of the run whose position changed. */
export async function recalcPositions(db, raceRunId) {
  const rows = await db
    .select({ id: results.id, finishTime: results.finishTime, gunDurationMs: results.gunDurationMs, status: results.status, position: results.position })
    .from(results)
    .where(eq(results.raceRunId, raceRunId))

  const positions = rankFinishers(rows)
  for (const r of rows) {
    const position = positions.get(r.id)
    if ((r.position ?? null) === position) continue
    await db.update(results).set({ position }).where(eq(results.id, r.id))
  }
}
