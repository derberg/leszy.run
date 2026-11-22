import { and, eq, isNotNull } from 'drizzle-orm'
import { teamBatons } from '../db/schema.js'

/**
 * The batons a baton-relay race needs at start: `[{ teamId, epc }]` of the event's teams with a
 * tag. Read only for a `relay_free` category counting baton passes; any other category gets
 * `undefined` and never touches `team_batons`.
 */
export async function batonsForCategory(db, category, eventId) {
  if (category.teamMode !== 'relay_free' || category.teamLapSource !== 'baton') return undefined
  return db.select({ teamId: teamBatons.teamId, epc: teamBatons.epc })
    .from(teamBatons)
    .where(and(eq(teamBatons.eventId, eventId), isNotNull(teamBatons.epc)))
}
