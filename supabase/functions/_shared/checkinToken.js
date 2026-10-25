// The `t` in a check-in link: HMAC-SHA256(event_secrets.checkin_link_key,
// participant id), base64url, 32 characters (192 bits). The participant id on
// its own is public (participants_public, results), so it cannot be the
// credential. backend/src/lib/checkinLink.js computes the same value with
// node:crypto when it builds the SMS; backend/test/checkinLink.test.js holds
// the two to one test vector.

export const TOKEN_LENGTH = 32

function base64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @returns {Promise<string>} */
export async function checkinToken(key, participantId) {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(participantId))
  return base64url(new Uint8Array(sig)).slice(0, TOKEN_LENGTH)
}

/** Constant-time string comparison. */
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
