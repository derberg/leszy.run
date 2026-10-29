// Checkpoint-PIN check for checkpoint-write and checkpoint-roster.
// checkpoint-roster used to count attempts in an in-memory Map keyed on the
// first X-Forwarded-For hop, which the caller writes, so a 6-digit PIN fell to
// anyone who rotated that header.
//
// The whole check is event_pin_ok() in SQL (migration
// 20261030020000_anon_lockdown.sql): it takes an advisory lock on the PIN,
// counts the recent failures, compares and records, so concurrent guesses
// cannot all read the same count. The lockout is per event, not per caller,
// because there is no caller identity a forger cannot change: 100 wrong PINs in
// 15 minutes lock the PIN for the volunteers and Pi agents too. Both stop
// sending on a wrong PIN and queue their entries, so a lockout delays an entry
// and loses none.

/**
 * @param {import('https://esm.sh/@supabase/supabase-js@2').SupabaseClient} admin service-role client
 * @param {{ eventId: string, pin: string }} p
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function checkCheckpointPin(admin, { eventId, pin }) {
  const { data, error } = await admin.rpc('event_pin_ok', {
    p_event_id: eventId, p_kind: 'checkpoint', p_pin: pin,
  })
  if (error) {
    if (/Too many attempts/.test(error.message ?? '')) return { ok: false, status: 429, error: 'Too many attempts' }
    console.error('[pinGuard] event_pin_ok failed', error)
    return { ok: false, status: 500, error: 'Lookup failed' }
  }
  return data === true ? { ok: true } : { ok: false, status: 401, error: 'Invalid PIN' }
}
