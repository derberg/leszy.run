import { and, eq, isNotNull, lte, ne, sql } from 'drizzle-orm'
import { events, participants, hostTeams } from '../../src/db/schema.js'
import { neutralTeamName } from '../../src/lib/hostTeams.js'

export const RETENTION_DAYS = 30

/** The newest event date (YYYY-MM-DD) whose registration contact data is due: Warsaw today minus 30 days. */
export function cutoffDate(now = new Date()) {
  const warsawToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
  const [y, m, d] = warsawToday.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - RETENTION_DAYS)).toISOString().slice(0, 10)
}

const due = (cutoff) => and(
  isNotNull(participants.registrationId),
  isNotNull(participants.phone),
  sql`${events.date} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
  lte(events.date, cutoff),
)

/**
 * Nulls participants.phone for the participants that came from an online
 * registration of an event 30 or more days past. Dry run unless apply is true.
 * Writing through Drizzle leaves the synced_at trigger to re-push the nulls.
 * → { cutoff, count, applied }
 */
export async function purgeRegistrationContact(db, { apply = false, now = new Date() } = {}) {
  const cutoff = cutoffDate(now)
  const rows = await db
    .select({ id: participants.id })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(due(cutoff))
  if (apply && rows.length > 0) {
    for (const { id } of rows) {
      await db.update(participants).set({ phone: null }).where(eq(participants.id, id))
    }
  }
  return { cutoff, count: rows.length, applied: apply }
}

/**
 * Replaces the names of host teams (host_teams) of an event 30 or more days past with the
 * neutral „Drużyna 1A2B3C4D”, as Supabase's purge_host_team_names() does. Supabase's run reaches
 * a clean host row through configSync; this covers a host that is offline or holds a dirty row,
 * whose push would otherwise send the old name back. Dry run unless apply is true.
 * → { cutoff, count, applied }
 */
export async function purgeHostTeamNames(db, { apply = false, now = new Date() } = {}) {
  const cutoff = cutoffDate(now)
  const rows = await db
    .select({ id: hostTeams.id, name: hostTeams.name })
    .from(hostTeams)
    .innerJoin(events, eq(events.id, hostTeams.eventId))
    .where(and(
      sql`${events.date} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`,
      lte(sql`left(${events.date}, 10)`, cutoff),
    ))
  const due = rows.filter(r => r.name !== neutralTeamName(r.id))
  if (apply) {
    for (const { id } of due) {
      await db.update(hostTeams).set({ name: neutralTeamName(id), updatedAt: new Date() })
        .where(and(eq(hostTeams.id, id), ne(hostTeams.name, neutralTeamName(id))))
    }
  }
  return { cutoff, count: due.length, applied: apply }
}
