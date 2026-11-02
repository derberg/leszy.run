// Security hardening of the login and profile edge functions: the post-login
// `from`, the session cookie parse, the login-address shape, the profile text
// caps and the per-IP cap on code verification.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFrom } from '../../../supabase/functions/_shared/safeFrom.js'
import { sessionTokenFrom, getSession } from '../../../supabase/functions/_shared/session.js'
import { isLoginEmail } from '../../../supabase/functions/_shared/loginEmail.js'
import { profileFieldsError } from '../../../supabase/functions/_shared/profileFields.js'
import { verifyCodeAndOpenSession, VERIFY_IP_LIMIT } from '../../../supabase/functions/_shared/verifyCode.js'

test('sanitizeFrom refuses control characters and off-site forms', () => {
  for (const bad of ['/\t/evil.com', '/\n/evil.com', '//evil.com', '/\\evil.com', '/a b', '/\u007fx', '/../x', 'x', '', null]) {
    assert.equal(sanitizeFrom(bad), null, JSON.stringify(bad))
  }
  assert.equal(sanitizeFrom('/ok/path?x=1'), '/ok/path?x=1')
  // Percent-encoded is harmless: the URL parser never decodes it into a scheme-relative URL.
  assert.equal(new URL('/%09/evil.com', 'https://www.leszy.run').origin, 'https://www.leszy.run')
  assert.equal(sanitizeFrom('/%09/evil.com'), '/%09/evil.com')
})

test('a malformed session cookie is no session, not a throw', async () => {
  assert.equal(sessionTokenFrom('leszy_session=%E0'), null)
  assert.equal(sessionTokenFrom(null), null)
  assert.equal(sessionTokenFrom('a=1; leszy_session=abc123'), 'abc123')
  const req = { headers: { get: () => 'leszy_session=%E0' } }
  const admin = { from: () => { throw new Error('must not query') } }
  assert.equal(await getSession(req, admin), null)
})

test('login addresses: permissive, but no filter or header metacharacters', () => {
  for (const ok of ['a@b.pl', 'first.last+tag@sub.example.com', 'a_b-c@x.io']) assert.equal(isLoginEmail(ok), true, ok)
  for (const bad of ['a,b@x.pl', 'a(b)@x.pl', 'a"b@x.pl', 'a\\b@x.pl', 'a<b>@x.pl', 'a b@x.pl', 'a@x.pl,target_username.eq.x', 'a@b', '', null, `${'a'.repeat(250)}@x.pl`]) {
    assert.equal(isLoginEmail(bad), false, String(bad))
  }
})

test('profile text fields are typed and capped', () => {
  assert.equal(profileFieldsError({}), null)
  assert.equal(profileFieldsError({ display_name: null, bio: null, avatar_url: null }), null)
  assert.equal(profileFieldsError({ display_name: 'x'.repeat(80), bio: 'y'.repeat(1000), avatar_url: 'https://x.pl/a.png' }), null)
  assert.ok(profileFieldsError({ display_name: 'x'.repeat(81) }))
  assert.ok(profileFieldsError({ display_name: { a: 1 } }))
  assert.ok(profileFieldsError({ bio: 'y'.repeat(1001) }))
  assert.ok(profileFieldsError({ bio: 5 }))
  assert.ok(profileFieldsError({ avatar_url: 'javascript:alert(1)' }))
  assert.ok(profileFieldsError({ avatar_url: 'http://x.pl/a.png' }))
  assert.ok(profileFieldsError({ avatar_url: `https://x.pl/${'a'.repeat(500)}` }))
})

// A fake admin whose claim_throttle_slot refuses one key, recording every key it sees.
function fakeAdmin(refuseKey) {
  const keys = []
  return {
    keys,
    rpc: async (name, args) => {
      assert.equal(name, 'claim_throttle_slot')
      keys.push([args.p_key, args.p_limit])
      return { data: [{ allowed: args.p_key !== refuseKey, retry_after_sec: 42 }], error: null }
    },
    from: () => { throw new Error('must not reach auth_codes') },
  }
}

test('verification is capped per IP, before the per-address limit', async () => {
  const admin = fakeAdmin('verify-ip:198.51.100.7')
  const out = await verifyCodeAndOpenSession(admin, { email: 'a@b.pl', code: '123456', ip: '198.51.100.7' })
  assert.deepEqual(out, { ok: false, status: 429, error: 'Zbyt wiele prób. Spróbuj ponownie później.', retryAfterSec: 42 })
  assert.deepEqual(admin.keys, [['verify-ip:198.51.100.7', VERIFY_IP_LIMIT]])
  assert.equal(VERIFY_IP_LIMIT, 300)
})

test('a missing IP counts in the shared unknown bucket; the per-address limit is unchanged', async () => {
  const admin = fakeAdmin('verify:a@b.pl')
  const out = await verifyCodeAndOpenSession(admin, { email: 'A@b.pl', code: '123456' })
  assert.equal(out.status, 429)
  assert.deepEqual(admin.keys, [['verify-ip:unknown', 300], ['verify:a@b.pl', 15]])
})
