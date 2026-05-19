import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Checks all badge definitions against a user's stats and awards any newly
 * earned badges. Safe to call multiple times — UNIQUE constraint prevents
 * double-awards. Called after every contribution submission and after admin
 * accepts a contribution.
 *
 * @param {ReturnType<typeof createClient>} supabaseAdmin service_role client
 * @param {string} userId
 */
export async function checkAndAwardBadges(supabaseAdmin, userId) {
  const [
    { count: acceptedReports },
    { count: acceptedSubmissions },
    { count: anyReports },
    { count: anySubmissions },
    { data: profile },
    { data: existingBadges },
    { data: definitions },
  ] = await Promise.all([
    supabaseAdmin.from('calendar_event_reports')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'accepted'),
    supabaseAdmin.from('calendar_events')
      .select('*', { count: 'exact', head: true })
      .eq('submitted_by', userId).eq('status', 'active'),
    supabaseAdmin.from('calendar_event_reports')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId),
    supabaseAdmin.from('calendar_events')
      .select('*', { count: 'exact', head: true })
      .eq('submitted_by', userId),
    supabaseAdmin.from('profiles').select('club').eq('id', userId).single(),
    supabaseAdmin.from('user_badges').select('badge_id').eq('user_id', userId),
    supabaseAdmin.from('badge_definitions').select('*'),
  ])

  const totalAccepted = (acceptedReports || 0) + (acceptedSubmissions || 0)
  const totalAny = (anyReports || 0) + (anySubmissions || 0)
  const existingIds = new Set((existingBadges || []).map(b => b.badge_id))
  const hasClub = Boolean(profile?.club)

  for (const badge of (definitions || [])) {
    if (existingIds.has(badge.id)) continue

    let qualifies = false
    switch (badge.condition_type) {
      case 'first_contribution':
        qualifies = totalAny >= 1
        break
      case 'accepted_reports_count':
        qualifies = (acceptedReports || 0) >= badge.condition_value
        break
      case 'accepted_submissions_count':
        qualifies = (acceptedSubmissions || 0) >= badge.condition_value
        break
      case 'accepted_count':
        qualifies = totalAccepted >= badge.condition_value
        break
      case 'club_set':
        qualifies = hasClub
        break
    }

    if (qualifies) {
      await supabaseAdmin.from('user_badges')
        .insert({ user_id: userId, badge_id: badge.id })
    }
  }
}
