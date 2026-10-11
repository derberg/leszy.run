// Retired addresses: the one thing that survives an account deletion, so the
// promise in the delete dialog ("adres email nie zostanie zwolniony") holds.
//
// Only a SHA-256 of the normalised address is kept — the list has to answer
// "was this retired?" and nothing else, and storing the plaintext of an account
// we just erased would defeat the erasure. Table: deleted_email_hashes
// (migration 20260929190000_account_deletion_hardening.sql).

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase()
}

export async function hashEmail(email) {
  const data = new TextEncoder().encode(normalizeEmail(email))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function isEmailRetired(supabaseAdmin, email) {
  const { data } = await supabaseAdmin
    .from('deleted_email_hashes')
    .select('email_hash')
    .eq('email_hash', await hashEmail(email))
    .maybeSingle()
  return Boolean(data)
}

export async function retireEmail(supabaseAdmin, email) {
  return supabaseAdmin
    .from('deleted_email_hashes')
    .upsert({ email_hash: await hashEmail(email) }, { onConflict: 'email_hash' })
}
