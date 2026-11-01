// A link that carries a secret must not go through SendGrid's click-tracking redirect, which
// would hand the login code to a third party. Asserts the payload SendGrid receives.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildSendGridBody, sendEmail } from '../../../supabase/functions/_shared/email.js'
import { requestLoginCode } from '../../../supabase/functions/_shared/requestCode.js'

const realFetch = globalThis.fetch
const realDeno = globalThis.Deno
afterEach(() => { globalThis.fetch = realFetch; globalThis.Deno = realDeno })

function stubEnv() {
  const env = { SENDGRID_API_KEY: 'k', SENDGRID_FROM_EMAIL: 'from@example.com' }
  globalThis.Deno = { env: { get: (k) => env[k] } }
  const sent = []
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response('', { status: 202 }) }
  return sent
}

// Every query ends in { data: null, error: null }; the throttle RPC says allowed.
function fakeAdmin() {
  const chain = new Proxy(() => {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : chain),
    apply: () => chain,
  })
  const result = { data: null, error: null }
  const query = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? (res) => res(result) : prop === 'maybeSingle' ? async () => result : () => query),
  })
  return { from: () => query, rpc: async () => ({ data: [{ allowed: true, retry_after_sec: 0 }], error: null }) }
}

test('the login e-mail turns SendGrid click tracking off', async () => {
  const sent = stubEnv()
  const res = await requestLoginCode(fakeAdmin(), { email: 'a@example.com', linkBase: 'https://www.leszy.run' })
  assert.equal(res.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].tracking_settings.click_tracking.enable, false)
  assert.equal(sent[0].tracking_settings.click_tracking.enable_text, false)
  assert.match(sent[0].content[0].value, /code=\d{6}/)
})

test('a message without noTracking leaves SendGrid tracking settings alone', async () => {
  const sent = stubEnv()
  await sendEmail({ to: 'a@example.com', subject: 's', text: 't' })
  assert.equal('tracking_settings' in sent[0], false)
  assert.equal(buildSendGridBody({ to: 'a@b.c', subject: 's', text: 't', noTracking: true }, 'f@x.y').tracking_settings.click_tracking.enable, false)
})
