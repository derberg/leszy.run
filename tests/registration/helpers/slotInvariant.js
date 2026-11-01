// The slot invariant of plan 5: per competition, taken = confirmed individual registrations +
// confirmed teams. An entry awaiting payment holds nothing (P3-R15). Every DB test of teams
// calls it in afterEach.
import { competitionOf, liveSlots } from './orders.js'

/** Throws with both numbers when competitions.taken and the confirmed entries disagree. */
export async function assertSlotInvariant(categoryId) {
  const competition = await competitionOf(categoryId)
  if (!competition) throw new Error(`Slot invariant: no competition ${categoryId}`)
  const confirmed = await liveSlots(categoryId)
  if (competition.taken !== confirmed) {
    throw new Error(`Slot invariant broken for ${categoryId}: taken ${competition.taken}, confirmed entries ${confirmed}`)
  }
}
