const WINDOW_MS = 15 * 60 * 1000

/**
 * Atomically check + increment a counter under a key.
 * @returns {Promise<{ allowed: boolean, retryAfterSec?: number }>}
 */
export async function checkAndIncrement(supabaseAdmin, key, limit) {
  const now = new Date()
  const cutoff = new Date(now.getTime() - WINDOW_MS)

  const { data: existing } = await supabaseAdmin
    .from('otp_throttle')
    .select('*')
    .eq('key', key)
    .single()

  if (!existing) {
    await supabaseAdmin.from('otp_throttle').insert({ key, attempts: 1 })
    return { allowed: true }
  }

  if (new Date(existing.window_started_at) < cutoff) {
    await supabaseAdmin
      .from('otp_throttle')
      .update({ attempts: 1, window_started_at: now.toISOString() })
      .eq('key', key)
    return { allowed: true }
  }

  if (existing.attempts >= limit) {
    const retryAfterSec = Math.ceil(
      (new Date(existing.window_started_at).getTime() + WINDOW_MS - now.getTime()) / 1000
    )
    return { allowed: false, retryAfterSec }
  }

  await supabaseAdmin
    .from('otp_throttle')
    .update({ attempts: existing.attempts + 1 })
    .eq('key', key)
  return { allowed: true }
}
