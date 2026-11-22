import { and, eq, isNotNull } from 'drizzle-orm'
import { teamBatons } from '../db/schema.js'

/**
 * The batons a relay-in-any-order race needs at start: `[{ teamId, epc }]` of the event's teams
 * with a tag. Read for every `relay_free` category (its laps come only from the baton); any other
 * category gets `undefined` and never touches `team_batons`.
 */
export async function batonsForCategory(db, category, eventId) {
  if (category.teamMode !== 'relay_free') return undefined
  return db.select({ teamId: teamBatons.teamId, epc: teamBatons.epc })
    .from(teamBatons)
    .where(and(eq(teamBatons.eventId, eventId), isNotNull(teamBatons.epc)))
}
