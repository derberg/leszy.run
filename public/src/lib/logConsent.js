import { POLICY_VERSION } from './policyVersion'
import { FUNCTIONS_BASE } from './auth.js'

export async function logConsentServerSide(decision = 'accepted') {
  try {
    await fetch(`${FUNCTIONS_BASE}/log-consent`, {
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
