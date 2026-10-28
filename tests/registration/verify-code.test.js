import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, admin, resetThrottle } from './helpers/stack.js'
import { startCapture, lastCodeFor, clearMessages } from './helpers/emailCapture.js'
import { verifyCodeAndOpenSession } from '../../supabase/functions/_shared/verifyCode.js'
import { RETIRED_EMAIL_MESSAGE } from '../../supabase/functions/_shared/deletedEmails.js'

const RETIRED_TEXT = 'Ten adres e-mail należał do usuniętego konta LESZY.RUN i nie może zostać użyty ponownie. Podaj inny adres albo napisz do nas: kontakt@leszy.run.'
const run = Date.now()
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

let stopCapture
before(async () => {
  stopCapture = await startCapture()
  await clearMessages()
  await resetThrottle()
})
after(async () => { if (stopCapture) await stopCapture() })

async function requestCode(email) {
  const res = await fetch(`${localEnv().functionsUrl}/auth-request-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  })
  assert.equal(res.status, 200, await res.text())
  let code = null
  for (let i = 0; i < 20 && !code; i++) {
    code = await lastCodeFor(email)
    if (!code) await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(code, 'login email captured')
  return code
}

/** Retires `email` and stores a valid login code for it directly (auth-request-code refuses it). */
async function retireWithCode(email, code) {
  const db = admin()
  let { error } = await db.from('deleted_email_hashes').upsert({ email_hash: sha256(email) }, { onConflict: 'email_hash' })
  assert.equal(error, null)
  ;({ error } = await db.from('auth_codes').insert({
    email, code_hash: sha256(code), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }))
  assert.equal(error, null)
}

test('F-15 the shared deleted-address message is the agreed text', () => {
  assert.equal(RETIRED_EMAIL_MESSAGE, RETIRED_TEXT)
})

test('F-15 verifyCodeAndOpenSession: a valid captured code opens a 90-day session', async () => {
  const email = `verify-ok-${run}@test.local`
  const code = await requestCode(email)
  const out = await verifyCodeAndOpenSession(admin(), { email: ` ${email.toUpperCase()} `, code })
  assert.equal(out.ok, true)
  assert.equal(out.email, email)
  assert.equal(out.profile.username, null)
  assert.match(out.cookie, /^leszy_session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=7776000$/)
  const token = out.cookie.match(/^leszy_session=([0-9a-f]{64})/)[1]
  const { data: session } = await admin().from('auth_sessions').select('user_id, email').eq('id', token).single()
  assert.deepEqual(session, { user_id: out.profile.id, email })
  const { data: used } = await admin().from('auth_codes').select('used').eq('email', email).single()
  assert.equal(used.used, true)
})

test('F-15 verifyCodeAndOpenSession: a wrong code answers 401', async () => {
  const email = `verify-wrong-${run}@test.local`
  const code = await requestCode(email)
  const wrong = code === '123456' ? '654321' : '123456'
  const out = await verifyCodeAndOpenSession(admin(), { email, code: wrong })
  assert.deepEqual(out, { ok: false, status: 401, error: 'Nieprawidłowy kod.' })
})

test('F-15 verifyCodeAndOpenSession: a retired address answers 403 email_retired and mints nothing', async () => {
  const email = `verify-retired-${run}@test.local`
  await retireWithCode(email, '246810')
  const out = await verifyCodeAndOpenSession(admin(), { email, code: '246810' })
  assert.deepEqual(out, { ok: false, status: 403, error: RETIRED_TEXT, code: 'email_retired' })
  const { data: profile } = await admin().from('profiles').select('id').eq('email', email).maybeSingle()
  assert.equal(profile, null)
})

test('F-15 both login functions answer a retired address with 403 email_retired', async () => {
  const { functionsUrl } = localEnv()
  const email = `fn-retired-${run}@test.local`
  await retireWithCode(email, '135790')
  const post = (fn, body) => fetch(`${functionsUrl}/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const r1 = await post('auth-request-code', { email })
  assert.equal(r1.status, 403)
  assert.deepEqual(await r1.json(), { error: RETIRED_TEXT, code: 'email_retired' })
  const r2 = await post('auth-verify-code', { email, code: '135790' })
  assert.equal(r2.status, 403)
  assert.deepEqual(await r2.json(), { error: RETIRED_TEXT, code: 'email_retired' })
  assert.equal(r2.headers.get('set-cookie'), null)
})

test('F-15 auth-verify-code keeps its other answers: 400 bad input, 400 no code, 401 wrong, 200 + cookie', async () => {
  const { functionsUrl } = localEnv()
  const post = (body) => fetch(`${functionsUrl}/auth-verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  let r = await post({ email: 'x@test.local', code: '12' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'Nieprawidłowe dane.' })

  r = await post({ email: `no-code-${run}@test.local`, code: '123456' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'Kod wygasł lub nie istnieje. Poproś o nowy.' })

  const email = `fn-ok-${run}@test.local`
  const code = await requestCode(email)
  r = await post({ email, code: code === '123456' ? '654321' : '123456' })
  assert.equal(r.status, 401)
  assert.deepEqual(await r.json(), { error: 'Nieprawidłowy kod.' })

  r = await post({ email, code })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { success: true, hasUsername: false })
  assert.match(r.headers.get('set-cookie'), /^leszy_session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=7776000$/)

  // The code is spent: a second submit gets the "no code" answer, as before.
  r = await post({ email, code })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'Kod wygasł lub nie istnieje. Poproś o nowy.' })
})

test('F-15 auth-verify-code: a fourth guess on one code is refused with 403', async () => {
  const { functionsUrl } = localEnv()
  const email = `fn-cap-${run}@test.local`
  const code = await requestCode(email)
  const wrong = code === '123456' ? '654321' : '123456'
  const post = (c) => fetch(`${functionsUrl}/auth-verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: c }),
  })
  for (let i = 0; i < 3; i++) assert.equal((await post(wrong)).status, 401)
  const r = await post(code)
  assert.equal(r.status, 403)
  assert.deepEqual(await r.json(), { error: 'Ten kod jest już nieaktualny. Poproś o nowy.' })
})

test('F-15 auth-verify-code: the 16th attempt on one address in the window is 429 with retry-after', async () => {
  const { functionsUrl } = localEnv()
  const email = `fn-throttle-${run}@test.local`
  const post = () => fetch(`${functionsUrl}/auth-verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: '123456' }),
  })
  for (let i = 0; i < 15; i++) assert.equal((await post()).status, 400)
  const r = await post()
  assert.equal(r.status, 429)
  assert.deepEqual(await r.json(), { error: 'Zbyt wiele prób. Spróbuj ponownie później.' })
  assert.match(r.headers.get('retry-after'), /^\d+$/)
})
