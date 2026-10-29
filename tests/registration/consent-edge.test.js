// Plan 4, task 4b: the consent page API and the reminders. Scenarios G-27, G-31, G-32, G-32b and
// G-32c in docs/registration/scenario-matrix.md:
//   consent-request      the page's read: first name only until the e-mail code, then the data
//   accept-consent       the acceptance (and data corrections before closes_at)
//   remind-consent       a manual reminder (payer or organizer), 3 per registration per 24 h
//   mark-consent-office  „Regulamin podpisany w biurze” (owner/admin)
//   registration-jobs    step consent_reminders: missing requests, failed first e-mails, the
//                        automatic reminder 72 h before closes_at
// LOCAL stack only; every event and address is random.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { CAPTURE_PORT } from './helpers/emailCaptureServer.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { consentIds, db, one, rows, rpc, runnerEmail, setSettings } from './helpers/orders.js'
import { BIEG, adult, registerGroup } from './helpers/groups.js'
import { newToken } from '../../supabase/functions/_shared/registration/tokens.js'
import { jobsSettings, runJobsAndBeat } from '../../supabase/functions/_shared/registration/jobsRun.js'

const GONE_LINK = 'Ten link został już użyty albo wygasł.'
const EDITS_CLOSED = 'Po zamknięciu zapisów dane poprawisz w biurze zawodów.'
const REMIND_LIMIT = 'Przypomnienie zostało już wysłane. Spróbuj jutro.'
const CONSENT_SUBJECT = /^Zapisano Cię na .+ — zaakceptuj regulamin$/
const REMINDER_SUBJECT = /^Przypomnienie: Zapisano Cię na .+ — zaakceptuj regulamin$/
const TOKEN_RE = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
const HOUR = 3_600_000
const OPERATOR = 'operator@leszy.test'

const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

let owner, stopCapture
before(async () => {
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  await drainConsentJobs()
})
after(async () => { if (stopCapture) await stopCapture() })

const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const fromNow = (ms) => new Date(Date.now() + ms).toISOString()

async function call(fn, body, { session = null, cookie = null, from = ip() } = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-forwarded-for': from,
      ...(session || cookie ? { cookie: cookie ?? session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') }
}

async function jobs() {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET }, body: '{}',
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.data
}

// Earlier runs leave requests behind; run the job until its consent step claims nothing.
async function drainConsentJobs() {
  for (let i = 0; i < 60; i++) {
    const d = await jobs()
    if (!d.consentReminders && !d.consentRequestsIssued && !d.consentEmailsResent) return
  }
  throw new Error('consent_reminders never drained')
}

async function waitForMail(email, n = 1, pred = () => true) {
  for (let i = 0; i < 40; i++) {
    const msgs = (await messagesTo(email)).filter(pred)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return (await messagesTo(email)).filter(pred)
}
const tokenOf = (mail) => mail.text.match(TOKEN_RE)?.[1]
const codeMails = async (email) => (await messagesTo(email)).filter((m) => /^\d{6} — /.test(m.subject))

/**
 * A free event with a payer (self) and an added adult (confirmed, awaiting consent), and an issued
 * request whose token the test knows. → { event, regId, email, payerEmail, payer, token, participantId }
 */
async function awaitingAdult({ issue = true } = {}) {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  const cat = event.categoryIds[0]
  const payerEmail = runnerEmail('payer')
  const email = runnerEmail('adult')
  const payer = await sessionFor(payerEmail)
  const r = await registerGroup(event, [
    adult(cat, 'self', payerEmail),
    adult(cat, 'adult', email, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M', ageGroupLabel: 'M open' }),
  ], { profileId: payer.profileId })
  assert.equal(r.error, null, r.error?.message)
  const added = r.data.registrations.find((x) => x.role === 'adult')
  let token = null
  if (issue) {
    const t = await newToken()
    const res = await rpc('issue_consent_request', { p_registration_id: added.id, p_token_hash: t.hash })
    assert.equal(res.data, true, res.error?.message)
    token = t.token
  }
  return { event, regId: added.id, participantId: added.participantId, email, payerEmail, payer, token }
}

const regOf = (id) => one('registrations', { id })
const requestOf = (regId) => one('consent_requests', { registration_id: regId })

/** Every key at any depth of a JSON value. */
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
  return out
}

function assertNeedsCodeOnly(body, ctx) {
  const d = body.data
  assert.equal(d.needsCode, true)
  assert.equal(d.firstName, 'Piotr')
  assert.match(d.emailHint, /^r\*\*\*@test\.local$/)
  assert.equal(d.event.slug, ctx.event.slug)
  assert.ok(d.event.name)
  assert.equal(d.competition.name, 'Bieg 9 km')
  const keys = keysDeep(body)
  for (const k of ['person', 'birthDate', 'phone', 'iceName', 'icePhone', 'lastName', 'email', 'city', 'club', 'gender', 'consents']) {
    assert.ok(!keys.has(k), `no ${k} before the code`)
  }
  const raw = JSON.stringify(body)
  assert.ok(!raw.includes(ctx.email), 'never the full address')
  assert.ok(!raw.includes('1990-01-01'), 'never the birth date')
  assert.ok(!raw.includes('500100200'), 'never the phone')
}

// ---------------------------------------------------------------- G-31

test('G-31 the link alone (no session, or the payer\'s) shows the first name and an address hint only; the code is sent to the registration\'s address and logs the added adult in', async () => {
  const ctx = await awaitingAdult()

  const anon = await call('consent-request', { token: ctx.token })
  assert.equal(anon.status, 200, JSON.stringify(anon.body))
  assertNeedsCodeOnly(anon.body, ctx)

  const asPayer = await call('consent-request', { token: ctx.token }, { session: ctx.payer })
  assert.equal(asPayer.status, 200, JSON.stringify(asPayer.body))
  assertNeedsCodeOnly(asPayer.body, ctx)

  // An address in the body is ignored: the code goes to the registration's address only.
  const sent = await call('consent-request', { token: ctx.token, sendCode: true, email: ctx.payerEmail }, { session: ctx.payer })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assertNeedsCodeOnly(sent.body, ctx)
  const codes = await waitForMail(ctx.email, 1, (m) => /^\d{6} — /.test(m.subject))
  assert.equal(codes.length, 1)
  assert.deepEqual(await codeMails(ctx.payerEmail), [], 'nothing to the payer')
  const code = codes[0].subject.slice(0, 6)

  assert.equal(await db().from('profiles').select('id').eq('email', ctx.email).maybeSingle().then((r) => r.data), null)
  const full = await call('consent-request', { token: ctx.token, code }, { session: ctx.payer })
  assert.equal(full.status, 200, JSON.stringify(full.body))
  const profile = await one('profiles', { email: ctx.email })
  assert.ok(profile, 'a profile for the added adult')
  const cookie = full.setCookie?.match(/leszy_session=([^;]+)/)?.[1]
  assert.ok(cookie, 'a session cookie')
  const sess = await one('auth_sessions', { id: cookie })
  assert.equal(sess.user_id, profile.id, "the adult's session, not the payer's")
  assert.notEqual(sess.user_id, ctx.payer.profileId)

  const d = full.body.data
  assert.equal(d.needsCode, undefined)
  assert.equal(d.person.firstName, 'Piotr')
  assert.equal(d.person.lastName, 'Borowy')
  assert.equal(d.person.birthDate, '1990-01-01')
  assert.equal(d.person.email, ctx.email)
  assert.equal(d.person.phone, '+48500100200')
  assert.equal(d.editable, true)
  assert.equal(d.competition.name, 'Bieg 9 km')
  assert.equal(d.event.slug, ctx.event.slug)
  assert.equal(d.regulaminUrl, 'https://example.org/regulamin.pdf')
  assert.deepEqual(d.consents.map((c) => c.kind).sort(), ['data_info', 'image', 'regulamin'])
  assert.ok(d.formFields && typeof d.formFields === 'object')
  assert.ok(!JSON.stringify(full.body).includes(ctx.token), 'the token never comes back')

  // With that session the page reads the data again without a code.
  const again = await call('consent-request', { token: ctx.token }, { cookie: `leszy_session=${cookie}` })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.person.lastName, 'Borowy')

  const acc = await call('accept-consent', {
    token: ctx.token, acceptedConsentIds: await consentIds(ctx.event.eventId), serviceRegulamin: true,
  }, { cookie: `leszy_session=${cookie}` })
  assert.equal(acc.status, 200, JSON.stringify(acc.body))
  const reg = await regOf(ctx.regId)
  assert.equal(reg.consent_state, 'accepted')
  assert.equal(reg.profile_id, profile.id)

  const used = await call('consent-request', { token: ctx.token }, { cookie: `leszy_session=${cookie}` })
  assert.equal(used.status, 410)
})

test('G-31 accept-consent: no session or the payer\'s → 403; boxes missing → 400 consents_required; an unknown token → 410', async () => {
  const ctx = await awaitingAdult()
  const ids = await consentIds(ctx.event.eventId)
  const body = { token: ctx.token, acceptedConsentIds: ids, serviceRegulamin: true }
  assert.equal((await call('accept-consent', body)).status, 403)
  assert.equal((await call('accept-consent', body, { session: ctx.payer })).status, 403)
  const me = await sessionFor(ctx.email)
  const noService = await call('accept-consent', { ...body, serviceRegulamin: false }, { session: me })
  assert.equal(noService.status, 400)
  assert.equal(noService.body.code, 'consents_required')
  const missing = await call('accept-consent', { ...body, acceptedConsentIds: ids.slice(1) }, { session: me })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'consents_required')
  assert.equal((await regOf(ctx.regId)).consent_state, 'awaiting')
  const unknown = await call('accept-consent', { ...body, token: (await newToken()).token }, { session: me })
  assert.equal(unknown.status, 410)
  assert.equal(unknown.body.error, GONE_LINK)

  // A cancelled entry → 409 gone, and the token stays unused.
  await db().from('registrations').update({ status: 'cancelled' }).eq('id', ctx.regId)
  const gone = await call('accept-consent', body, { session: me })
  assert.equal(gone.status, 409)
  assert.equal(gone.body.code, 'gone')
  assert.equal((await requestOf(ctx.regId)).used_at, null)
})

test('G-31 accept-consent with edits before closes_at: a valid phone updates the entry and the participant; a minor\'s birth date → 422 edit_invalid; the address is never editable', async () => {
  const ctx = await awaitingAdult()
  const me = await sessionFor(ctx.email)
  const base = { token: ctx.token, acceptedConsentIds: await consentIds(ctx.event.eventId), serviceRegulamin: true }

  const minor = await call('accept-consent', { ...base, edits: { birthDate: '2015-01-01' } }, { session: me })
  assert.equal(minor.status, 422, JSON.stringify(minor.body))
  assert.equal(minor.body.code, 'edit_invalid')
  assert.ok(minor.body.fields?.birthDate)
  const mail = await call('accept-consent', { ...base, edits: { email: 'inny@test.local' } }, { session: me })
  assert.equal(mail.status, 422)
  assert.equal(mail.body.code, 'edit_invalid')
  const badPhone = await call('accept-consent', { ...base, edits: { phone: 'abc' } }, { session: me })
  assert.equal(badPhone.status, 422)
  assert.ok(badPhone.body.fields?.phone)
  assert.equal((await requestOf(ctx.regId)).used_at, null, 'refusals leave the token unused')

  const ok = await call('accept-consent', { ...base, edits: { phone: '+48 600 700 800', firstName: 'Piotr' } }, { session: me })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const reg = await regOf(ctx.regId)
  assert.equal(reg.phone, '+48 600 700 800')
  assert.equal(reg.consent_state, 'accepted')
  const part = await one('participants', { id: ctx.participantId })
  assert.equal(part.phone, '+48 600 700 800')
})

// ---------------------------------------------------------------- G-27

test('G-27 after closes_at: accept with edits.phone → 422 edits_closed; accept without edits → 200, participant unchanged', async () => {
  const ctx = await awaitingAdult()
  await setSettings(ctx.event.eventId, { opens_at: ago(48 * HOUR), closes_at: ago(HOUR) })
  const me = await sessionFor(ctx.email)
  const before = await one('participants', { id: ctx.participantId })

  const page = await call('consent-request', { token: ctx.token }, { session: me })
  assert.equal(page.status, 200, JSON.stringify(page.body))
  assert.equal(page.body.data.editable, false)

  const base = { token: ctx.token, acceptedConsentIds: await consentIds(ctx.event.eventId), serviceRegulamin: true }
  const edit = await call('accept-consent', { ...base, edits: { phone: '+48 600 700 800' } }, { session: me })
  assert.equal(edit.status, 422, JSON.stringify(edit.body))
  assert.equal(edit.body.code, 'edits_closed')
  assert.equal(edit.body.error, EDITS_CLOSED)
  assert.equal((await requestOf(ctx.regId)).used_at, null)

  // The unchanged fields sent back are not edits.
  const ok = await call('accept-consent', { ...base, edits: { phone: '+48500100200', firstName: 'Piotr' } }, { session: me })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const reg = await regOf(ctx.regId)
  assert.equal(reg.consent_state, 'accepted')
  assert.equal(reg.phone, '+48500100200')
  const after = await one('participants', { id: ctx.participantId })
  assert.equal(after.phone, before.phone)
  assert.equal(after.updated_at, before.updated_at)
})

// ---------------------------------------------------------------- G-32b throttles

test('G-32b the 31st consent-request from one IP in an hour → 429; the 11th call for one token → 429', async () => {
  await resetThrottle()
  const from = `203.0.113.${crypto.randomInt(1, 255)}`
  for (let i = 0; i < 30; i++) {
    const r = await call('consent-request', { token: (await newToken()).token }, { from })
    assert.equal(r.status, 410, `call ${i + 1}: ${JSON.stringify(r.body)}`)
  }
  const ipCapped = await call('consent-request', { token: (await newToken()).token }, { from })
  assert.equal(ipCapped.status, 429)
  assert.ok(ipCapped.body.error)

  const ctx = await awaitingAdult()
  for (let i = 0; i < 10; i++) {
    const r = await call('consent-request', { token: ctx.token })
    assert.equal(r.status, 200, `call ${i + 1}: ${JSON.stringify(r.body)}`)
  }
  const tokenCapped = await call('consent-request', { token: ctx.token })
  assert.equal(tokenCapped.status, 429)
  // accept-consent counts on the same per-token counter.
  const me = await sessionFor(ctx.email)
  const acc = await call('accept-consent', {
    token: ctx.token, acceptedConsentIds: await consentIds(ctx.event.eventId), serviceRegulamin: true,
  }, { session: me })
  assert.equal(acc.status, 429)
  assert.equal((await regOf(ctx.regId)).consent_state, 'awaiting')
})

test('G-32b a wrong code three times spends the code (Plan 1\'s attempt cap); a retired address gets no code', async () => {
  await resetThrottle()
  const ctx = await awaitingAdult()
  assert.equal((await call('consent-request', { token: ctx.token, sendCode: true })).status, 200)
  const [mail] = await waitForMail(ctx.email, 1, (m) => /^\d{6} — /.test(m.subject))
  const code = mail.subject.slice(0, 6)
  const wrong = code === '111111' ? '222222' : '111111'
  for (let i = 0; i < 3; i++) {
    const r = await call('consent-request', { token: ctx.token, code: wrong })
    assert.equal(r.status, 401, JSON.stringify(r.body))
    assert.equal(r.setCookie, null)
  }
  const late = await call('consent-request', { token: ctx.token, code })
  assert.equal(late.status, 403, JSON.stringify(late.body))
  assert.equal(late.setCookie, null)
  assert.equal(late.body.data, undefined)

  const retired = await awaitingAdult()
  const hash = crypto.createHash('sha256').update(retired.email.toLowerCase()).digest('hex')
  const ins = await db().from('deleted_email_hashes').insert({ email_hash: hash })
  assert.equal(ins.error, null, ins.error?.message)
  const refused = await call('consent-request', { token: retired.token, sendCode: true })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'email_retired')
  assert.deepEqual(await codeMails(retired.email), [])
})

// ---------------------------------------------------------------- G-32 reminders and the office

test('G-32 remind-consent: a stranger → 404; the payer → 200 and a new e-mail whose old link fails; the 4th call in 24 h → 429', async () => {
  await resetThrottle()
  const ctx = await awaitingAdult()
  const stranger = await sessionFor(runnerEmail('stranger'))
  assert.equal((await call('remind-consent', { registrationId: ctx.regId }, { session: stranger })).status, 404)
  assert.equal((await call('remind-consent', { registrationId: ctx.regId })).status, 401)
  assert.equal((await call('remind-consent', { registrationId: 'nope' }, { session: ctx.payer })).status, 404)
  const member = await sessionFor('member@zatyrani-test.local')
  assert.equal((await call('remind-consent', { registrationId: ctx.regId }, { session: member })).status, 404)

  const r1 = await call('remind-consent', { registrationId: ctx.regId }, { session: ctx.payer })
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  const [mail] = await waitForMail(ctx.email, 1, (m) => REMINDER_SUBJECT.test(m.subject))
  assert.ok(mail, 'a reminder e-mail')
  const fresh = tokenOf(mail)
  assert.ok(fresh)
  assert.notEqual(fresh, ctx.token)
  assert.equal((await call('consent-request', { token: ctx.token })).status, 410, 'the old link is dead')
  assert.equal((await call('consent-request', { token: fresh })).status, 200, 'the new one works')
  assert.ok(!JSON.stringify(r1.body).includes(fresh), 'the token is only in the e-mail')
  assert.ok((await requestOf(ctx.regId)).last_reminded_at)

  // The organizer (admin) may remind too, logged; the 4th reminder within 24 h is refused.
  const adminS = await sessionFor('admin@zatyrani-test.local')
  assert.equal((await call('remind-consent', { registrationId: ctx.regId }, { session: adminS })).status, 200)
  const logged = await rows('organizer_actions', { target: ctx.regId })
  assert.deepEqual(logged.map((a) => a.action), ['consent_reminded'])
  assert.equal((await call('remind-consent', { registrationId: ctx.regId }, { session: ctx.payer })).status, 200)
  const fourth = await call('remind-consent', { registrationId: ctx.regId }, { session: ctx.payer })
  assert.equal(fourth.status, 429)
  assert.equal(fourth.body.error, REMIND_LIMIT)
  assert.equal((await waitForMail(ctx.email, 3, (m) => REMINDER_SUBJECT.test(m.subject))).length, 3)
})

test('G-32 remind-consent for an entry that no longer awaits → 409; mark-consent-office: admin → office + one organizer_actions row, member → 403, stranger → 404', async () => {
  await resetThrottle()
  const ctx = await awaitingAdult()
  const member = await sessionFor('member@zatyrani-test.local')
  const stranger = await sessionFor(runnerEmail('stranger'))
  const adminS = await sessionFor('admin@zatyrani-test.local')

  assert.equal((await call('mark-consent-office', { registrationId: ctx.regId }, { session: member })).status, 403)
  assert.equal((await call('mark-consent-office', { registrationId: ctx.regId }, { session: stranger })).status, 404)
  assert.equal((await call('mark-consent-office', { registrationId: ctx.regId }, { session: ctx.payer })).status, 404)
  assert.equal((await regOf(ctx.regId)).consent_state, 'awaiting')

  const r = await call('mark-consent-office', { registrationId: ctx.regId }, { session: adminS })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await regOf(ctx.regId)).consent_state, 'office')
  const logged = await rows('organizer_actions', { target: ctx.regId })
  assert.deepEqual(logged.map((a) => a.action), ['consent_office'])
  assert.ok((await requestOf(ctx.regId)).used_at)

  const twice = await call('mark-consent-office', { registrationId: ctx.regId }, { session: adminS })
  assert.equal(twice.status, 409)
  assert.equal((await rows('organizer_actions', { target: ctx.regId })).length, 1)
  const remind = await call('remind-consent', { registrationId: ctx.regId }, { session: ctx.payer })
  assert.equal(remind.status, 409)
  assert.equal((await call('consent-request', { token: ctx.token })).status, 410)
})

// ---------------------------------------------------------------- G-32c the job

test('G-32c registration-jobs: a request 71 h before close → exactly one reminder whose link works while the original fails; a second run → none', async () => {
  const ctx = await awaitingAdult()
  await setSettings(ctx.event.eventId, { closes_at: fromNow(71 * HOUR) })
  await db().from('consent_requests').update({ sent_at: ago(48 * HOUR), emailed_at: ago(48 * HOUR) })
    .eq('registration_id', ctx.regId)

  const run1 = await jobs()
  assert.ok(run1.consentReminders >= 1, JSON.stringify(run1))
  const mails = await waitForMail(ctx.email, 1, (m) => REMINDER_SUBJECT.test(m.subject))
  assert.equal(mails.length, 1)
  const fresh = tokenOf(mails[0])
  assert.equal((await call('consent-request', { token: fresh })).status, 200)
  assert.equal((await call('consent-request', { token: ctx.token })).status, 410)
  assert.ok((await requestOf(ctx.regId)).auto_reminded_at)

  const run2 = await jobs()
  assert.equal(run2.consentReminders, 0)
  await sleep(500)
  assert.equal((await messagesTo(ctx.email)).filter((m) => REMINDER_SUBJECT.test(m.subject)).length, 1)
})

test('G-32c the job issues a request a crash left missing, and re-sends a first e-mail that never went out; each once', async () => {
  // (a) a confirmed added adult with no request at all (the function died after the commit)
  const missing = await awaitingAdult({ issue: false })
  // (b) a request whose first e-mail was not sent (emailed_at null), issued over 10 min ago
  const failed = await awaitingAdult()
  await db().from('consent_requests').update({ sent_at: ago(HOUR) }).eq('registration_id', failed.regId)
  // a request issued a minute ago is still in flight: left alone
  const young = await awaitingAdult()

  const run1 = await jobs()
  assert.ok(run1.consentRequestsIssued >= 1, JSON.stringify(run1))
  assert.ok(run1.consentEmailsResent >= 1, JSON.stringify(run1))

  const first = await waitForMail(missing.email, 1, (m) => CONSENT_SUBJECT.test(m.subject))
  assert.equal(first.length, 1)
  assert.ok(tokenOf(first[0]))
  assert.equal((await call('consent-request', { token: tokenOf(first[0]) })).status, 200)
  assert.ok((await requestOf(missing.regId)).emailed_at, 'a sent e-mail is stamped')

  const resent = await waitForMail(failed.email, 1, (m) => CONSENT_SUBJECT.test(m.subject))
  assert.equal(resent.length, 1)
  assert.equal((await call('consent-request', { token: tokenOf(resent[0]) })).status, 200)
  assert.equal((await call('consent-request', { token: failed.token })).status, 410, 'the never-delivered link is replaced')
  assert.ok((await requestOf(failed.regId)).emailed_at)

  await jobs()
  await sleep(500)
  assert.equal((await messagesTo(missing.email)).length, 1)
  assert.equal((await messagesTo(failed.email)).length, 1)
  assert.deepEqual(await messagesTo(young.email), [])
})

test('G-32c without dpay settings the consent step still runs and sends (P3-R16)', async () => {
  const ctx = await awaitingAdult()
  await setSettings(ctx.event.eventId, { closes_at: fromNow(70 * HOUR) })
  await db().from('consent_requests').update({ sent_at: ago(30 * HOUR), emailed_at: ago(30 * HOUR) })
    .eq('registration_id', ctx.regId)
  const env = { PIPELINE_ALERT_EMAIL: OPERATOR, EMAIL_CAPTURE_URL: `http://127.0.0.1:${CAPTURE_PORT}/send`, PUBLIC_SITE_URL: 'http://localhost:5173' }
  const hadDeno = 'Deno' in globalThis
  const prev = globalThis.Deno
  globalThis.Deno = { env: { get: (k) => env[k] } }
  try {
    const settings = jobsSettings(env)
    assert.equal(settings.dpayMissing, true)
    const data = await runJobsAndBeat(db(), settings, {})
    assert.equal(data.skipped.consent_reminders, undefined)
    assert.ok(data.consentReminders >= 1, JSON.stringify(data))
    const mails = await waitForMail(ctx.email, 1, (m) => REMINDER_SUBJECT.test(m.subject))
    assert.equal(mails.length, 1)
    assert.ok(mails[0].text.includes('http://localhost:5173/zgoda#'))
  } finally {
    if (hadDeno) globalThis.Deno = prev
    else delete globalThis.Deno
  }
})

test('G-32c the new job functions are executable by the service role only', async () => {
  const { url, anonKey } = localEnv()
  const { createClient } = await import('@supabase/supabase-js')
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  for (const fn of ['consent_requests_missing', 'claim_consent_resends']) {
    const r = await anon.rpc(fn, { p_limit: 1 })
    assert.ok(r.error, `anon must not run ${fn}`)
  }
})
