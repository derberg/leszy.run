import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndAwardBadges } from '../_shared/badge-check.js'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Authorization required' }, 401)

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) return json({ error: 'Invalid token' }, 401)

    const adminIds = (Deno.env.get('ADMIN_USER_IDS') || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!adminIds.includes(user.id)) return json({ error: 'Forbidden' }, 403)

    const { type, id, action, admin_note } = await req.json()
    if (!['accept', 'reject'].includes(action)) {
      return json({ error: 'action must be accept or reject' }, 400)
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
      return json({ error: 'Invalid type. Must be event_report, event_submission, or general_feedback' }, 400)
    }

    if (action === 'accept' && contributorUserId) {
      await checkAndAwardBadges(supabaseAdmin, contributorUserId)
    }

    return json({ ok: true })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})
