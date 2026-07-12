import { supabase } from './supabaseClient.js'

/**
 * Log an admin action to the admin_actions table in Supabase.
 *
 * userId is optional — backend Fastify routes have no per-user auth middleware,
 * so userId will be null for all backend-originated actions. Edge functions
 * always pass session.userId.
 *
 * Errors are logged but never thrown — audit failure must not break the main operation.
 */
export async function logAdminAction({ userId = null, action, targetTable, targetId, payload, req } = {}) {
  if (!supabase) return // Supabase not configured — skip
  const ip = req
    ? ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null)
    : null
  const ua = req ? (req.headers['user-agent'] || null) : null
  const { error } = await supabase.from('admin_actions').insert({
    admin_user_id: userId,
    action,
    target_table: targetTable || null,
    target_id: targetId ? String(targetId) : null,
    payload: payload || null,
    ip_inet: ip || null,
    user_agent: ua,
  })
  if (error) console.error('[adminAudit] insert failed:', error.message)
}
