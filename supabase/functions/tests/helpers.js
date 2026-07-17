import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Creates an auth user + profile + session in DB. Returns { user, sessionToken, email }. */
export async function createTestSession(suffix = 'test') {
  const email = `test-${suffix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@test.leszy.run`

  // Create a real auth.users row so tables whose user_id FK references auth.users
  // (e.g. consent_log) can be seeded against this session. The profile id matches
  // the auth user id (profiles.id FK → auth.users.id).
  const { data: created, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (authError) throw authError
  const userId = created.user.id

  const sessionToken = crypto.randomBytes(32).toString('hex')
  try {
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({ id: userId, email })
    if (profileError) throw profileError

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const { error: sessionError } = await supabaseAdmin
      .from('auth_sessions')
      .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
    if (sessionError) throw sessionError
  } catch (err) {
    // Clean up the auth user we just created so it doesn't accumulate as an orphan.
    try { await supabaseAdmin.auth.admin.deleteUser(userId) } catch { /* best-effort */ }
    throw err
  }

  return { user: { id: userId, email }, sessionToken, email }
}

/** Marker prefix for content tests write to shared tables (reports, feedback).
 *  Lets the sweep identify orphaned test rows even after their user is gone. */
export const E2E_MARKER = '[e2e-test]'

/**
 * Deletes everything a test user generated, then the session(s), profile, and
 * auth user. Content rows MUST go first: profiles.user_id FKs are ON DELETE
 * SET NULL, so deleting the profile first orphans reports/feedback and they
 * become invisible to user_id-based cleanup (this is exactly how test junk
 * leaked into the admin moderation tabs).
 */
export async function cleanupUser(userId) {
  await supabaseAdmin.from('calendar_event_reports').delete().eq('user_id', userId)
  await supabaseAdmin.from('website_feedback').delete().eq('user_id', userId)
  await supabaseAdmin.from('event_favorites').delete().eq('user_id', userId)
  await supabaseAdmin.from('user_badges').delete().eq('user_id', userId)
  await supabaseAdmin.from('consent_log').delete().eq('user_id', userId)
  // Clubs: delete owned clubs (cascades members/invites), then any remaining memberships
  const { data: owned } = await supabaseAdmin.from('clubs').select('id').eq('owner_id', userId)
  for (const c of owned ?? []) await cleanupClub(c.id)
  await supabaseAdmin.from('club_members').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').update({ club_id: null }).eq('id', userId)
  await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').delete().eq('id', userId)
  // Best-effort: remove the auth.users row created in createTestSession.
  try { await supabaseAdmin.auth.admin.deleteUser(userId) } catch { /* ignore */ }
}

/** Deletes a club's invites, memberships, detaches profiles, then the club row itself. */
export async function cleanupClub(clubId) {
  if (!clubId) return
  await supabaseAdmin.from('club_invites').delete().eq('club_id', clubId)
  await supabaseAdmin.from('club_members').delete().eq('club_id', clubId)
  await supabaseAdmin.from('profiles').update({ club_id: null }).eq('club_id', clubId)
  await supabaseAdmin.from('clubs').delete().eq('id', clubId)
}

/**
 * Creates a club via the real create-club edge function as the given session
 * (so owner membership + profiles.club_id are set exactly like production).
 * Returns the created club row ({ id, name, slug, ... }).
 */
export async function createClub(sessionToken, name) {
  const res = await callFunction('create-club', { name }, sessionToken)
  if (res.status !== 200) {
    throw new Error(`createClub failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return res.data.data.club
}

/**
 * Removes leftovers from previous crashed/interrupted test runs. Safe to run
 * against production data: every predicate matches only test artifacts
 * (@test.leszy.run emails, source='test' events, E2E_MARKER-tagged content).
 * Run before each suite — see sweep.js and the Playwright global setup.
 */
export async function sweepTestData() {
  // Profiles from prior runs (cleans their content via cleanupUser).
  const { data: staleProfiles } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .like('email', '%@test.leszy.run')
  for (const p of staleProfiles || []) await cleanupUser(p.id)

  // Orphaned marker-tagged content (user already deleted → user_id is NULL).
  await supabaseAdmin.from('calendar_event_reports').delete().like('note', `${E2E_MARKER}%`)
  await supabaseAdmin.from('calendar_event_reports').delete().like('suggested_value', `${E2E_MARKER}%`)
  await supabaseAdmin.from('website_feedback').delete().like('message', `${E2E_MARKER}%`)

  // Test calendar events (favorites/notifications/delete-account suites).
  await supabaseAdmin.from('calendar_events').delete().eq('source', 'test')

  // OTP rows keyed by email, and clubs created by the onboarding e2e flow.
  await supabaseAdmin.from('auth_codes').delete().like('email', '%@test.leszy.run')
  await supabaseAdmin.from('clubs').delete().like('name', 'KB Testowo%')
}

/** POST to an edge function. Pass sessionToken to send as cookie. */
export async function callFunction(name, body, sessionToken = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['Cookie'] = `leszy_session=${sessionToken}`
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
