// Plan 4 task 4b, fix round 1: the consent page's address hint (m3) and the one client-IP parser
// shared by consent-request and auth-request-code (nit).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { emailHint } from '../../../supabase/functions/_shared/registration/consentAccess.js'
import { clientIp } from '../../../supabase/functions/_shared/clientIp.js'

test('G-36 m3 emailHint shows the first letter, the first letter of the domain and its TLD, never the address', () => {
  assert.equal(emailHint('piotr@gmail.com'), 'p***@g***.com')
  assert.equal(emailHint('Jan.Kowalski@mail.example.co.uk'), 'J***@m***.uk')
  assert.equal(emailHint('runner-adult-1@test.local'), 'r***@t***.local')
  assert.equal(emailHint('a@x.pl'), '*@x***.pl', 'a one-character local part shows nothing of it')
  assert.equal(emailHint('ab@localhost'), 'a***@l***')
  for (const e of ['a@kowalski.pl', 'ab@kowalski.pl', 'jan@kowalski-firma.pl']) {
    const h = emailHint(e)
    assert.ok(!h.includes(e.split('@')[0] + '@'), `${h} hides the local part`)
    assert.ok(!h.includes(e.split('@')[1].split('.')[0]), `${h} hides the domain`)
  }
  assert.equal(emailHint(null), '*@*')
})

test('G-36 nit: one validated client-IP parser, used by auth-request-code and the organizer side', () => {
  const req = (xff) => ({ headers: { get: (k) => (k === 'x-forwarded-for' ? xff : null) } })
  // SEC-1: the element left of the platform-appended peer, never the left-most one.
  assert.equal(clientIp(req('203.0.113.9, 10.0.0.1')), '203.0.113.9')
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9, 10.0.0.1')), '203.0.113.9')
  assert.equal(clientIp(req('2001:db8::1')), '2001:db8::1')
  assert.equal(clientIp(req('not-an-ip')), null)
  assert.equal(clientIp(req('not-an-ip, 10.0.0.1')), '10.0.0.1')
  assert.equal(clientIp(req('')), null)
  assert.equal(clientIp(req(null)), null)
  const src = readFileSync(new URL('../../../supabase/functions/auth-request-code/index.js', import.meta.url), 'utf8')
  // auth-request-code hands the request to requestLoginCode, which keys its limits through clientIp.js.
  assert.match(src, /requestLoginCode\(supabaseAdmin, \{\s*email, req,/)
  assert.doesNotMatch(src, /function clientIp/)
  assert.match(readFileSync(new URL('../../../supabase/functions/_shared/requestCode.js', import.meta.url), 'utf8'), /from '\.\/clientIp\.js'/)
  // The 429's retry-after is set whenever the limiter gave a value, 0 included (as before 4b).
  assert.match(src, /retryAfterSec != null/)
})
