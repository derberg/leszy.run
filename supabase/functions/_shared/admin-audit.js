export async function logAdminAction(supabaseAdmin, { userId, action, targetTable, targetId, payload, req }) {
  const ip = (req?.headers?.get?.('x-forwarded-for') || '').split(',')[0].trim() || null
  const ua = req?.headers?.get?.('user-agent') || null
  const { error } = await supabaseAdmin.from('admin_actions').insert({
    admin_user_id: userId || null,
    action,
    target_table: targetTable || null,
    target_id: targetId || null,
    payload: payload || null,
    ip_inet: ip || null,
    user_agent: ua,
  })
  if (error) console.error('admin-audit insert failed:', error)
}
