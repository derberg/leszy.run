// Append-only club membership history (club_membership_log). Best-effort —
// a log failure must never fail the user-facing action.
export async function logMembershipEvent(supabaseAdmin, { club_id, user_id, event, role = null, actor_id = null }) {
  try {
    await supabaseAdmin.from('club_membership_log').insert({ club_id, user_id, event, role, actor_id })
  } catch (_) { /* best-effort */ }
}
