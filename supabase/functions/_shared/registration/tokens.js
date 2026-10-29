// Single-use link tokens (consent requests, Plan 4; transfers, Plan 7). The token
// travels only in the link; the database keeps its SHA-256, so a leaked table
// row opens nothing. Plain ESM on Web Crypto: runs in Deno, Node and the browser.

const TOKEN_BYTES = 32 // 256 bits → 43 base64url characters

function base64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 of the token, lowercase hex: the value stored and looked up. */
export async function hashToken(token) {
  if (typeof token !== 'string') throw new TypeError('token must be a string')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh random token and its hash → { token, hash }. */
export async function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  const token = base64url(bytes)
  return { token, hash: await hashToken(token) }
}
