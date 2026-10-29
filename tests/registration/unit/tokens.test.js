// Plan 4, task 3: the consent-request token helpers (G-26 unit part in
// docs/registration/scenario-matrix.md). The token travels in a link; only its
// SHA-256 is stored.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashToken, newToken } from '../../../supabase/functions/_shared/registration/tokens.js'

test('G-26 hashToken is the SHA-256 hex of the token', async () => {
  assert.equal(await hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(await hashToken(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('G-26 newToken yields 43 base64url characters and the hash of exactly that token', async () => {
  const seen = new Set()
  for (let i = 0; i < 50; i++) {
    const { token, hash } = await newToken()
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(hash, await hashToken(token))
    seen.add(token)
  }
  assert.equal(seen.size, 50, 'every token is fresh')
})

test('G-26 hashToken refuses a non-string', async () => {
  await assert.rejects(() => hashToken(undefined), TypeError)
  await assert.rejects(() => hashToken(42), TypeError)
})
