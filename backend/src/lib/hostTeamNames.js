// What the host itself knows about an event's team names, read the same way by GET
// /events/:eventId/team-names and GET /races/:raceRunId/teams, which both pass it to
// mergeTeamNames (lib/hostTeams.js): its host_teams rows, and the teams that have a live member
// from the online registration (their host name, if any, is dropped).
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { hostTeams, participants } from '../db/schema.js'

export async function localTeamNameInputs(db, eventId) {
  const [hostRows, regMembers] = await Promise.all([
    db.select({ id: hostTeams.id, name: hostTeams.name }).from(hostTeams).where(eq(hostTeams.eventId, eventId)),
    db.select({ teamId: participants.teamId }).from(participants).where(and(
      eq(participants.eventId, eventId), isNotNull(participants.teamId), isNotNull(participants.registrationId),
      isNull(participants.removedAt), isNull(participants.deletedAt),
    )),
  ])
  return { hostRows, registrationMemberTeamIds: regMembers.map(m => m.teamId) }
}
