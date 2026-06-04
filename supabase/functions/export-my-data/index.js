// supabase/functions/export-my-data/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

const POLICY_VERSION = '2026-06-04'

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req)
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401, req)
  }

  const userId = session.userId

  const [profile, userBadges, consentLog, eventReports, websiteFeedback, submittedEvents] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userId).single(),
    supabaseAdmin.from('user_badges').select('*').eq('user_id', userId),
    supabaseAdmin.from('consent_log').select('*').eq('user_id', userId),
    supabaseAdmin.from('calendar_event_reports').select('*').eq('user_id', userId),
    supabaseAdmin.from('website_feedback').select('*').eq('user_id', userId),
    supabaseAdmin.from('calendar_events').select('*').eq('submitted_by', userId),
  ])

  const body = {
    exported_at: new Date().toISOString(),
    policy_version_at_export: POLICY_VERSION,
    account: profile.data || null,
    badges: userBadges.data || [],
    consent_log: consentLog.data || [],
    contributions: {
      calendar_event_reports: eventReports.data || [],
      website_feedback: websiteFeedback.data || [],
      submitted_calendar_events: submittedEvents.data || [],
    },
  }

  const date = new Date().toISOString().slice(0, 10)
  return json(body, 200, req, {
    'Content-Disposition': `attachment; filename="leszy-run-dane-${userId}-${date}.json"`,
  })
})
