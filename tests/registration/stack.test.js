import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { localEnv, admin, sessionFor, loginViaEmail, resetThrottle } from './helpers/stack.js'
import { startCapture, messagesTo, clearMessages } from './helpers/emailCapture.js'

let stopCapture
before(async () => {
  stopCapture = await startCapture()
  await clearMessages()
  await resetThrottle()
})
after(async () => { if (stopCapture) await stopCapture() })

test('the local stack answers with the service key', async () => {
  const { error } = await admin().from('profiles').select('id').limit(1)
  assert.equal(error, null)
})

test('localEnv points at the local stack only', () => {
  assert.ok(localEnv().url.startsWith('http://127.0.0.1'))
})

test('loginViaEmail: real code flow, email captured with sender name and html', async () => {
  const email = 'runner@test.local'
  const cookie = await loginViaEmail(email)
  assert.match(cookie, /^leszy_session=/)
  const msgs = await messagesTo(email)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].fromName, 'Łukasz z LESZY.RUN')
  assert.ok(msgs[0].html && msgs[0].html.includes('<html'))
  assert.match(msgs[0].subject, /Twój kod logowania do Leszy\.run/)
})

test('sessionFor cookie is accepted by auth-me', async () => {
  const { cookie, profileId } = await sessionFor('x@test.local')
  const res = await fetch(`${localEnv().functionsUrl}/auth-me`, { headers: { cookie } })
  const body = await res.json()
  assert.equal(body.user.id, profileId)
  assert.equal(body.user.email, 'x@test.local')
})
