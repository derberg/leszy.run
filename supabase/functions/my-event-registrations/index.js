import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { allRows } from '../_shared/registration/allRows.js'
import { isValidSlug } from '../_shared/registration/slug.js'
import { registrationRole } from '../_shared/registration/group.js'
import { kidsGroupLabels } from '../_shared/registration/kidsGroupLabels.js'
import { transferViews } from '../_shared/registration/transfers.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}



// POST { slug } → 200 { data: [{ id, competition, ageGroupLabel, startTime,
// firstName, lastName, status, createdAt, role: self|adult|minor, consentState,
// kidsGroupLabel (a child's kids' group, else null), mine (the session's own entry),
// teamId, teamName, isCaptain, transfer: { allowed, until, pending: { transferId, toEmail,
// createdAt, expiresAt } | null } }] }:
// the confirmed registrations of that published (or closed) event that are the
// session's own or that the session registered (a group's payer sees every person
// of it, Plan 4). 401 without a session, 404 for an unknown slug or a draft.
// transfer (Plan 7): whether the session may hand this entry on now (its own adult entry, a
// team's only as captain, transfers on and today ≤ until), the organizer's last day (`until`,
// null when transfers are off) and the session's own open invite (an invite past expires_at is
// not open). Another person's entry the session registered always reads { allowed: false,
// pending: null }: only the holder transfers.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const slug = body?.slug
    if (!isValidSlug(slug)) return json({ error: 'Not found' }, 404, req)
    const { data: settings, error } = await admin.from('registration_settings')
      .select('event_id, state, first_start_time, event_date, transfer_enabled, transfer_until').eq('slug', slug).maybeSingle()
    if (error) throw error
    if (!settings || settings.state === 'draft') return json({ error: 'Not found' }, 404, req)

    const listed = await allRows(() => admin.from('registrations')
      .select('id, category_id, first_name, last_name, age_group_label, kids_group_id, status, created_at, consent_state, team_id, profile_id, registered_by_profile_id, guardian_name, guardian_profile_id, guardian_removed_at, guardian_named, email, birth_date')
      .eq('event_id', settings.event_id).eq('status', 'confirmed')
      .or(`profile_id.eq.${session.userId},registered_by_profile_id.eq.${session.userId}`)
      .order('created_at').order('id'))
    // M-4: organizer_transfer stores the organizer as registered_by_profile_id. Such an entry is
    // the organizer's panel data, not somebody the organizer signed up on this page: left out
    // unless it is the session's own start.
    const others = listed.filter((r) => r.profile_id !== session.userId).map((r) => r.id)
    const byOrganizer = others.length
      ? new Set((await allRows(() => admin.from('transfers').select('id, new_registration_id')
        .eq('kind', 'organizer').in('new_registration_id', others).order('id'))).map((t) => t.new_registration_id))
      : new Set()
    const regs = listed.filter((r) => !byOrganizer.has(r.id))
    const categoryIds = [...new Set(regs.map((r) => r.category_id))]
    const comps = categoryIds.length
      ? await allRows(() => admin.from('competitions').select('category_id, name, start_time').in('category_id', categoryIds).order('category_id'))
      : []
    const compOf = new Map(comps.map((c) => [c.category_id, c]))
    const kidsLabel = await kidsGroupLabels(admin, regs)
    const teamIds = [...new Set(regs.map((r) => r.team_id).filter(Boolean))]
    const teams = teamIds.length
      ? await allRows(() => admin.from('teams').select('id, name, captain_registration_id').in('id', teamIds).order('id'))
      : []
    const teamOf = new Map(teams.map((t) => [t.id, t]))
    const transfers = await transferViews(admin, regs, settings, session.userId)

    return json({
      data: regs.map((r) => {
        const c = compOf.get(r.category_id)
        const team = teamOf.get(r.team_id)
        return {
          id: r.id,
          competition: c?.name ?? null,
          ageGroupLabel: r.age_group_label,
          kidsGroupLabel: (r.kids_group_id && kidsLabel.get(r.kids_group_id)) || null,
          startTime: (c?.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null,
          firstName: r.first_name,
          lastName: r.last_name,
          status: r.status,
          createdAt: r.created_at,
          role: registrationRole(r),
          consentState: r.consent_state,
          mine: r.profile_id != null && r.profile_id === session.userId,
          teamId: team?.id ?? null,
          teamName: team?.name ?? null,
          isCaptain: team?.captain_registration_id === r.id,
          transfer: transfers.get(r.id),
        }
      }),
    }, 200, req)
  } catch (err) {
    console.error('my-event-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
