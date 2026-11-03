// The magic link in a login e-mail carries a live code, so the host it points at must never be one
// the caller chose with its Origin header. A preview pattern match or a localhost origin against the
// deployed project falls back to production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailLinkBase, isAllowed } from '../../../supabase/functions/_shared/cors.js'

const PROD = 'https://kojoxazlnxncrpxmnxiq.supabase.co'
const LOCAL = 'http://kong:8000'

test('production origin keeps its own host', () => {
  assert.equal(emailLinkBase('https://www.leszy.run', PROD), 'https://www.leszy.run')
})

test('an origin matching the preview pattern never receives a login link', () => {
  const attacker = 'https://evil-derbergs-projects.vercel.app'
  assert.equal(isAllowed(attacker), true, 'still allowed for CORS; the cookie never reaches it')
  assert.equal(emailLinkBase(attacker, PROD), 'https://www.leszy.run')
  assert.equal(emailLinkBase(attacker, LOCAL), 'https://www.leszy.run')
})

test('localhost gets the link only while the functions run on a local stack', () => {
  assert.equal(emailLinkBase('http://localhost:3002', PROD), 'https://www.leszy.run')
  assert.equal(emailLinkBase('http://localhost:3002', LOCAL), 'http://localhost:3002')
  assert.equal(emailLinkBase('http://127.0.0.1:5173', 'http://127.0.0.1:54321'), 'http://127.0.0.1:5173')
})

test('missing or foreign origins fall back to production', () => {
  for (const o of [null, undefined, '', 'null', 'https://evil.example', 'https://leszy.run.evil.example']) {
    assert.equal(emailLinkBase(o, PROD), 'https://www.leszy.run')
  }
  assert.equal(emailLinkBase('http://localhost:3002', undefined), 'https://www.leszy.run')
  assert.equal(emailLinkBase('http://localhost:3002', 'https://kong.example'), 'https://www.leszy.run')
})
