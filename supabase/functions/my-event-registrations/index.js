import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { isValidSlug } from '../_shared/registration/slug.js'
import { registrationRole } from '../_shared/registration/group.js'
import { kidsGroupLabels } from '../_shared/registration/kidsGroupLabels.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const PAGE = 1000

// PostgREST caps a response at 1000 rows, so every list read pages.
async function allRows(makeQuery) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...data)
    if (data.length < PAGE) return out
  }
}

// POST { slug } → 200 { data: [{ id, competition, ageGroupLabel, startTime,
// firstName, lastName, status, createdAt, role: self|adult|minor, consentState,
// kidsGroupLabel (a child's kids' group, else null), mine (the session's own entry) }] }:
// the confirmed registrations of that published (or closed) event that are the
// session's own or that the session registered (a group's payer sees every person
// of it, Plan 4). 401 without a session, 404 for an unknown slug or a draft.
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
      .select('event_id, state, first_start_time').eq('slug', slug).maybeSingle()
    if (error) throw error
    if (!settings || settings.state === 'draft') return json({ error: 'Not found' }, 404, req)

    const regs = await allRows(() => admin.from('registrations')
      .select('id, category_id, first_name, last_name, age_group_label, kids_group_id, status, created_at, consent_state, profile_id, registered_by_profile_id, guardian_name, guardian_profile_id')
      .eq('event_id', settings.event_id).eq('status', 'confirmed')
      .or(`profile_id.eq.${session.userId},registered_by_profile_id.eq.${session.userId}`)
      .order('created_at').order('id'))
    const categoryIds = [...new Set(regs.map((r) => r.category_id))]
    const comps = categoryIds.length
      ? await allRows(() => admin.from('competitions').select('category_id, name, start_time').in('category_id', categoryIds).order('category_id'))
      : []
    const compOf = new Map(comps.map((c) => [c.category_id, c]))
    const kidsLabel = await kidsGroupLabels(admin, regs)

    return json({
      data: regs.map((r) => {
        const c = compOf.get(r.category_id)
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
        }
      }),
    }, 200, req)
  } catch (err) {
    console.error('my-event-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
