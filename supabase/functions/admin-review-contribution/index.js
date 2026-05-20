import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndAwardBadges } from '../_shared/badge-check.js'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status = 200, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const session = await getSession(req, supabaseAdmin)
    if (!session) return json({ error: 'Authorization required' }, 401, req)
    const adminIds = (Deno.env.get('ADMIN_USER_IDS') || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!adminIds.includes(session.userId)) return json({ error: 'Forbidden' }, 403, req)

    const { type, id, action, admin_note } = await req.json()
    if (!['accept', 'reject'].includes(action)) {
      return json({ error: 'action must be accept or reject' }, 400, req)
    }

    let contributorUserId = null
    const now = new Date().toISOString()

    if (type === 'event_report') {
      const { data } = await supabaseAdmin
        .from('calendar_event_reports')
        .update({
          status: action === 'accept' ? 'accepted' : 'rejected',
          reviewed_at: now,
          ...(admin_note ? { note: admin_note } : {}),
        })
        .eq('id', id)
        .select('user_id')
        .single()
      contributorUserId = data?.user_id
    } else if (type === 'event_submission') {
      const { data } = await supabaseAdmin
        .from('calendar_events')
        .update({ status: action === 'accept' ? 'active' : 'rejected' })
        .eq('id', id)
        .select('submitted_by')
        .single()
      contributorUserId = data?.submitted_by
    } else if (type === 'general_feedback') {
      const { data } = await supabaseAdmin
        .from('website_feedback')
        .update({
          status: action === 'accept' ? 'reviewed' : 'dismissed',
          reviewed_at: now,
          ...(admin_note ? { admin_note } : {}),
        })
        .eq('id', id)
        .select('user_id')
        .single()
      contributorUserId = data?.user_id
    } else {
      return json({ error: 'Invalid type. Must be event_report, event_submission, or general_feedback' }, 400, req)
    }

    if (action === 'accept' && contributorUserId) {
      await checkAndAwardBadges(supabaseAdmin, contributorUserId)
    }

    return json({ ok: true }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
