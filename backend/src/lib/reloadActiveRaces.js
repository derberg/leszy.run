import { eq } from 'drizzle-orm'
import { raceRuns } from '../db/schema.js'
import { startListFor } from './registrationGuards.js'

// After a host restart mid-race, feed every active run back to the crossing
// detector. The start list is the same one race start uses (`startListFor`):
// a runner removed online must not get back into the detector's EPC map, or a
// chip read would give them a start, a finish or gun time.
export async function reloadActiveRaces(db, detector) {
  if (!detector) return 0
  const activeRuns = await db.query.raceRuns.findMany({
    where: eq(raceRuns.status, 'active'),
    with: {
      category: {
        with: {
          event: true,
          participants: true,
        },
      },
    },
  })
  for (const run of activeRuns) {
    await detector.startRace(run, run.category.event, startListFor(run.category.participants))
  }
  return activeRuns.length
}
