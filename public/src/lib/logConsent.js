import { POLICY_VERSION } from './policyVersion'

export async function logConsentServerSide(decision = 'accepted') {
  try {
    const apiUrl = import.meta.env.VITE_SUPABASE_URL
    if (!apiUrl) return
    await fetch(`${apiUrl}/functions/v1/log-consent`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision,
        policyVersion: POLICY_VERSION,
      }),
    })
  } catch (err) {
    console.warn('[consent] server-side log failed:', err)
  }
}
