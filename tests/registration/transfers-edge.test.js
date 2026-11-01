// Plan 7, task 7: the transfer edge functions and e-mails. Scenarios V-50…V-55, V-57, V-58 and
// V-59 in docs/registration/scenario-matrix.md:
//   transfer-invite         the holder: create (the invite e-mail), cancel, status
//   transfer-accept         the recipient: preview, sendCode, accept
//   my-event-registrations  each row's transfer block (a lapsed invite is not pending)
//   organizer-entry-action  `transfer` (ruling 4) and the consent request it issues
//   order-status / registration-jobs  the buyer's view of a line whose package was handed on
//   export-my-data          who provided the data of an entry an organizer transfer created
// The RPCs are tested in transfers-rpc.test.js. LOCAL stack only; every event and address is random.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { lastCodeFor, messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { attemptFor, confirmOk, consentIds, db, one, orderOf, person, profileFor, rows, runnerEmail, setSettings } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, orderGroupOk } from './helpers/groups.js'
import { dayBefore, enableTransfers, hashToken, paidEntry } from './helpers/transfers.js'
import { warsawToday } from '../../supabase/functions/_shared/registration/dates.js'

const GONE = 'Ten link został już użyty, cofnięty albo wygasł.'
const TOKEN_RE = /\/przekazanie#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
const CONSENT_SUBJECT = /^Zapisano Cię na .+ — zaakceptuj regulamin$/
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

let owner, stopCapture
before(async () => {
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (stopCapture) await stopCapture() })

const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  return { status: res.status, body: json, text, setCookie: res.headers.get('set-cookie') }
}

async function waitForMail(email, n = 1, pred = () => true) {
  for (let i = 0; i < 40; i++) {
    const msgs = (await messagesTo(email)).filter(pred)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return (await messagesTo(email)).filter(pred)
}
const bySubject = (re) => (m) => re.test(m.subject)

/** A paid event with transfers on until the day before the race. */
async function paidEvent() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), DZIECI()], prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })
  await enableTransfers(event)
  return event
}

/** A paid entry and its holder's session → { event, a (paidEntry), holder }. */
async function holderOf(event = null) {
  const ev = event ?? await paidEvent()
  const a = await paidEntry(ev)
  return { event: ev, a, holder: await sessionFor(a.email) }
}

/** transfer-invite create that must succeed → { transferId, token, toEmail, mail }. */
async function invited(a, holder, toEmail = runnerEmail('invitee')) {
  const res = await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail }, { session: holder })
  assert.equal(res.status, 201, res.text)
  const [mail] = await waitForMail(toEmail, 1, bySubject(/przekazuje Ci start/))
  assert.ok(mail, 'the invite e-mail')
  const token = mail.text.match(TOKEN_RE)?.[1]
  assert.ok(token, 'the token sits in the link fragment')
  return { transferId: res.body.data.transferId, token, toEmail, mail, body: res.body }
}

const recipientPerson = (email, over = {}) => {
  const { ageGroupLabel: _l, ...p } = person(email, { firstName: 'Jan', lastName: 'Nowak', gender: 'M', ...over })
  return p
}

/** sendCode to `email`, then accept with the code → the accept response. */
async function acceptWithCode(event, token, email, { over = {}, consents, serviceRegulamin = true, categoryId = event.categoryIds[0] } = {}) {
  const sent = await call('transfer-accept', { token, sendCode: true, email })
  assert.equal(sent.status, 200, sent.text)
  let code = null
  for (let i = 0; i < 40 && !code; i++) { code = await lastCodeFor(email); if (!code) await sleep(250) }
  assert.ok(code, 'a login code was mailed')
  return call('transfer-accept', {
    token, code, person: recipientPerson(email, over), categoryId,
    acceptedConsentIds: consents ?? await consentIds(event.eventId), serviceRegulamin,
  })
}

const transferOf = (id) => one('transfers', { id })

// ---------------------------------------------------------------- V-50 create, status, the list

test('V-50 create: no session 401, a stranger 404; the holder invites, the token lives only in the fragment', async () => {
  const { event, a, holder } = await holderOf()
  const toEmail = runnerEmail('invitee')

  assert.equal((await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail })).status, 401)
  const stranger = await sessionFor(runnerEmail('stranger'))
  const foreign = await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail }, { session: stranger })
  assert.equal(foreign.status, 404)
  assert.equal((await call('transfer-invite', { action: 'status', registrationId: a.reg.id }, { session: stranger })).status, 404)
  assert.equal((await rows('transfers', { registration_id: a.reg.id })).length, 0, 'nothing was created for the stranger')

  const bad = await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail: 'nie-adres' }, { session: holder })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'invalid_email')

  const inv = await invited(a, holder, toEmail)
  const row = await transferOf(inv.transferId)
  assert.equal(row.token_hash, hashToken(inv.token), 'only the SHA-256 is stored')
  assert.ok(row.invite_emailed_at, 'the invite was claimed before it went out')
  assert.ok(!inv.body.text?.includes(inv.token) && !JSON.stringify(inv.body).includes(inv.token), 'the answer never carries the token')
  assert.equal(inv.mail.subject, `Ola przekazuje Ci start — ${(await one('registration_settings', { event_id: event.eventId })).name}`)
  assert.match(inv.mail.text, /poza LESZY\.RUN/)
  assert.equal(inv.mail.trackClicks, false, 'click tracking off: no redirect may rewrite the token link')

  const again = await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail: runnerEmail('second') }, { session: holder })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'pending_exists')
  assert.equal(again.body.error, 'Zaproszenie już wysłane. Cofnij je, aby wysłać nowe.')

  const status = await call('transfer-invite', { action: 'status', registrationId: a.reg.id }, { session: holder })
  assert.equal(status.status, 200, status.text)
  assert.equal(status.body.data.allowed, true)
  assert.equal(status.body.data.until, dayBefore(event.eventDate))
  assert.equal(status.body.data.pending.toEmail, toEmail)
  assert.equal(status.body.data.pending.transferId, inv.transferId)

  // my-event-registrations carries the same block; an invite past expires_at is not pending.
  const list = await call('my-event-registrations', { slug: event.slug }, { session: holder })
  assert.equal(list.status, 200, list.text)
  const mine = list.body.data.find((r) => r.id === a.reg.id)
  assert.deepEqual(mine.transfer, status.body.data)
  await db().from('transfers').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', inv.transferId)
  const lapsed = await call('my-event-registrations', { slug: event.slug }, { session: holder })
  assert.equal(lapsed.body.data.find((r) => r.id === a.reg.id).transfer.pending, null, 'a lapsed invite reads as not pending')
  assert.equal((await transferOf(inv.transferId)).status, 'pending', 'its status still says pending')
  // M-3: taking back a lapsed invite is answered as expired, and the invitee is told nothing.
  const late = await call('transfer-invite', { action: 'cancel', transferId: inv.transferId }, { session: holder })
  assert.equal(late.status, 409)
  assert.equal(late.body.code, 'expired')
  await sleep(300)
  assert.equal((await messagesTo(toEmail)).filter(bySubject(/^Zaproszenie cofnięte/)).length, 0)
  assert.equal((await transferOf(inv.transferId)).cancel_emailed_at, null)

  // Transfers switched off → not allowed, and create answers transfer_off.
  await setSettings(event.eventId, { transfer_enabled: false })
  const off = await call('transfer-invite', { action: 'status', registrationId: a.reg.id }, { session: holder })
  assert.deepEqual(off.body.data, { allowed: false, until: null, pending: null })
})

test('V-50 create: 5 invites per entry per 24 h, the 6th is 429', async () => {
  const { a, holder } = await holderOf()
  for (let i = 0; i < 5; i++) {
    const inv = await invited(a, holder)
    assert.equal((await call('transfer-invite', { action: 'cancel', transferId: inv.transferId }, { session: holder })).status, 200)
  }
  const sixth = await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail: runnerEmail('six') }, { session: holder })
  assert.equal(sixth.status, 429)
})

// ---------------------------------------------------------------- V-51 preview

test('V-51 preview: the sender by first name only; same-price competitions, consents, the last day', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const res = await call('transfer-accept', { token: inv.token })
  assert.equal(res.status, 200, res.text)
  const d = res.body.data
  assert.equal(d.senderFirstName, 'Ola')
  for (const secret of ['Leśna', a.email, '+48500100200', '500100200', '1990-01-01']) {
    assert.ok(!res.text.includes(secret), `the preview must not carry ${secret}`)
  }
  assert.equal(d.competition.categoryId, event.categoryIds[0])
  assert.equal(d.priceLabel, '60,00 zł')
  assert.deepEqual(d.competitions.map((c) => c.categoryId), [event.categoryIds[0]], 'the 20 zł competition is not offered')
  const ids = await consentIds(event.eventId)
  assert.deepEqual(d.consents.map((c) => c.id).sort(), [...ids].sort())
  assert.ok(d.consents.some((c) => c.kind === 'image'), 'the image acceptance is listed')
  assert.equal(d.until, dayBefore(event.eventDate))
  assert.ok(!res.text.includes(inv.token), 'the token never comes back')

  assert.equal((await call('transfer-accept', { token: 'x'.repeat(43) })).body.code, 'gone')
  assert.equal((await call('transfer-accept', { token: 'not a token' })).status, 409)
})

// ---------------------------------------------------------------- V-52 forwarded link

test('V-52 a forwarded link is accepted by a third address; the sender is told who, each e-mail once', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const third = runnerEmail('third')
  const res = await acceptWithCode(event, inv.token, third)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.data.status, 'accepted')
  assert.match(res.setCookie ?? '', /leszy_session=/, 'the code opened a session')

  const t = await transferOf(inv.transferId)
  assert.equal(t.status, 'accepted')
  assert.ok(t.accepted_emailed_at && t.confirmation_emailed_at)
  const newReg = await one('registrations', { id: res.body.data.registrationId })
  assert.equal(newReg.email, third)
  assert.equal(newReg.status, 'confirmed')
  assert.equal(newReg.profile_id, await profileFor(third))

  const name = (await one('registration_settings', { event_id: event.eventId })).name
  const told = await waitForMail(a.email, 1, bySubject(/^Pakiet przejęła/))
  assert.equal(told.length, 1)
  assert.equal(told[0].subject, `Pakiet przejęła Jan Nowak — ${name}`)
  assert.ok(!`${told[0].text}${told[0].html}`.includes(third), 'the sender is not given the address')
  const confirmed = await waitForMail(third, 1, bySubject(/^Jesteś na liście/))
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].subject, `Jesteś na liście — ${name}`)
  assert.equal((await messagesTo(inv.toEmail)).filter(bySubject(/^Jesteś na liście/)).length, 0, 'the invited address got nothing more')

  // The link is spent: another try is gone, and no e-mail goes out twice.
  const again = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(third), categoryId: event.categoryIds[0],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  }, { cookie: res.setCookie.match(/leszy_session=[^;]+/)[0] })
  assert.equal(again.status, 409)
  assert.equal(again.body.error, GONE)
  await sleep(500)
  assert.equal((await messagesTo(a.email)).filter(bySubject(/^Pakiet przejęła/)).length, 1)
})

test('V-52 accept refusals: no code 401, a bad person 400 invalid_person, a minor 409, a retired address 403', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const email = runnerEmail('acc')
  const noCode = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(email), categoryId: event.categoryIds[0],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  })
  assert.equal(noCode.status, 401)
  assert.equal(noCode.body.code, 'code_required')
  // M-6: a session on another address is no proof of this one: still a code.
  const other = await sessionFor(runnerEmail('other'))
  const wrongSession = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(email), categoryId: event.categoryIds[0],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  }, { session: other })
  assert.equal(wrongSession.status, 401)
  assert.equal(wrongSession.body.code, 'code_required')

  const session = await sessionFor(email)
  const badPhone = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(email, { phone: 'x' }), categoryId: event.categoryIds[0],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  }, { session })
  assert.equal(badPhone.status, 400)
  assert.equal(badPhone.body.code, 'invalid_person')
  assert.ok(badPhone.body.fields.phone)

  const child = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(email, { birthDate: '2012-01-01' }), categoryId: event.categoryIds[0],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  }, { session })
  assert.equal(child.status, 409)
  assert.equal(child.body.code, 'recipient_minor')
  assert.equal(child.body.error, 'Pakiet może przejąć tylko osoba pełnoletnia.')

  const otherPrice = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(email), categoryId: event.categoryIds[1],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  }, { session })
  assert.equal(otherPrice.status, 409)
  assert.equal(otherPrice.body.error, 'Wybierz konkurencję w tej samej cenie.')

  const retired = runnerEmail('retired')
  const hash = crypto.createHash('sha256').update(retired).digest('hex')
  await db().from('deleted_email_hashes').insert({ email_hash: hash })
  const refused = await call('transfer-accept', { token: inv.token, sendCode: true, email: retired })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'email_retired')
  assert.equal((await transferOf(inv.transferId)).status, 'pending')
})

// ---------------------------------------------------------------- V-53 cancel

test('V-53 accept after cancel → 409 gone; the invitee got one cancel e-mail', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const stranger = await sessionFor(runnerEmail('stranger'))
  assert.equal((await call('transfer-invite', { action: 'cancel', transferId: inv.transferId }, { session: stranger })).status, 404)

  const cancel = await call('transfer-invite', { action: 'cancel', transferId: inv.transferId }, { session: holder })
  assert.equal(cancel.status, 200, cancel.text)
  const twice = await call('transfer-invite', { action: 'cancel', transferId: inv.transferId }, { session: holder })
  assert.equal(twice.status, 409)
  assert.equal(twice.body.code, 'not_pending')

  const code = await call('transfer-accept', { token: inv.token, sendCode: true, email: inv.toEmail })
  assert.equal(code.status, 409)
  assert.equal(code.body.code, 'gone')
  const session = await sessionFor(inv.toEmail)
  const res = await call('transfer-accept', {
    token: inv.token, person: recipientPerson(inv.toEmail), categoryId: event.categoryIds[0],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  }, { session })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'gone')
  assert.equal(res.body.error, GONE)
  const preview = await call('transfer-accept', { token: inv.token })
  assert.equal(preview.status, 409)
  assert.equal(preview.body.error, GONE)

  await sleep(500)
  const cancelled = (await messagesTo(inv.toEmail)).filter(bySubject(/^Zaproszenie cofnięte — /))
  assert.equal(cancelled.length, 1)
  assert.ok((await transferOf(inv.transferId)).cancel_emailed_at)
  assert.equal((await one('registrations', { id: a.reg.id })).status, 'confirmed')
})

// ---------------------------------------------------------------- V-54 throttle

test('V-54 the 11th call on one token within the hour → 429', async () => {
  const { a, holder } = await holderOf()
  const inv = await invited(a, holder)
  for (let i = 0; i < 10; i++) assert.equal((await call('transfer-accept', { token: inv.token })).status, 200, `call ${i + 1}`)
  const eleventh = await call('transfer-accept', { token: inv.token })
  assert.equal(eleventh.status, 429)
  assert.ok(eleventh.body.code === 'throttled')
})

// ---------------------------------------------------------------- V-55 / V-59 organizer transfer

test('V-55 an organizer transfer after transfer_until → 200, a consent request naming the club, one organizer_actions row (V-59)', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  await setSettings(event.eventId, { transfer_until: dayBefore(warsawToday()) })
  const email = runnerEmail('org')
  const body = { action: 'transfer', registrationId: a.reg.id, categoryId: event.categoryIds[0], person: recipientPerson(email) }

  const bad = await call('organizer-entry-action', { ...body, person: recipientPerson(email, { phone: '' }) }, { session: owner })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.code, 'invalid_person')

  const res = await call('organizer-entry-action', body, { session: owner })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.data.consentState, 'awaiting')
  const newReg = await one('registrations', { id: res.body.data.registrationId })
  assert.equal(newReg.consent_state, 'awaiting')
  assert.equal((await one('registrations', { id: a.reg.id })).status, 'transferred_out')

  const actions = await rows('organizer_actions', { event_id: event.eventId, action: 'registration_transferred' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].target, a.reg.id)
  assert.ok(!JSON.stringify(actions[0].payload).includes(email), 'the audit row holds ids only')

  const settings = await one('registration_settings', { event_id: event.eventId })
  const club = await one('clubs', { id: settings.club_id })
  const [mail] = await waitForMail(email, 1, bySubject(CONSENT_SUBJECT))
  assert.ok(mail, 'the consent request went to the new adult')
  assert.ok(mail.text.startsWith('Cześć Jan,'))
  assert.ok(mail.text.includes(`${club.name} zapisał(a) Cię`), 'the club is named as the source (Art. 14(2)(f))')
  assert.ok(!mail.text.includes('Ola Leśna'), 'not the original buyer')
  assert.equal(mail.trackClicks, false, 'the consent link is never click-tracked')

  // M-2: the old holder is told, by the new holder's name and never their address.
  assert.equal(res.body.data.holderNotified, true)
  const [notice] = await waitForMail(a.email, 1, bySubject(/^Pakiet przekazany — /))
  assert.ok(notice, 'the old holder got a notice')
  assert.equal(notice.subject, `Pakiet przekazany — ${settings.name}`)
  assert.match(notice.text, /Jan Nowak/)
  assert.ok(!`${notice.text}${notice.html}`.includes(email))
  const orgTransfer = (await rows('transfers', { registration_id: a.reg.id })).find((t) => t.kind === 'organizer')
  assert.ok(orgTransfer.holder_emailed_at)

  // M-4: the organizer's own runner page does not list the person they typed in.
  const own = await call('my-event-registrations', { slug: event.slug }, { session: owner })
  assert.equal(own.status, 200, own.text)
  assert.ok(!own.body.data.some((r) => r.id === newReg.id))

  // V-59: the new adult's own export names the club too.
  const recipient = await sessionFor(email)
  const exp = await call('export-my-data', {}, { session: recipient })
  assert.equal(exp.status, 200, exp.text)
  const exported = exp.body.registrations.find((r) => r.id === newReg.id)
  assert.ok(exported, 'the transferred entry is in the export')
  assert.deepEqual(exported.registered_by, { name: club.name })

  // The organizer's own panel says who provided it.
  const list = await call('list-event-registrations', { eventId: event.eventId }, { session: owner })
  assert.equal(list.status, 200, list.text)
  assert.equal(list.body.data.find((r) => r.id === newReg.id).registeredBy, 'Organizator')

  const twice = await call('organizer-entry-action', body, { session: owner })
  assert.equal(twice.status, 409)
})

// ---------------------------------------------------------------- V-57 consents

test('V-57 accept without every consent or the service regulamin → 400, nothing accepted; then the full set', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const email = runnerEmail('v57')
  const session = await sessionFor(email)
  const ids = await consentIds(event.eventId)
  const imageId = (await rows('event_consents', { event_id: event.eventId })).find((c) => c.kind === 'image').id
  const base = { token: inv.token, person: recipientPerson(email), categoryId: event.categoryIds[0] }

  const noImage = await call('transfer-accept', { ...base, acceptedConsentIds: ids.filter((i) => i !== imageId), serviceRegulamin: true }, { session })
  assert.equal(noImage.status, 400)
  assert.equal(noImage.body.code, 'consents_required')
  const noService = await call('transfer-accept', { ...base, acceptedConsentIds: ids, serviceRegulamin: false }, { session })
  assert.equal(noService.status, 400)
  assert.equal(noService.body.code, 'consents_required')
  assert.equal((await transferOf(inv.transferId)).status, 'pending')

  const ok = await call('transfer-accept', { ...base, acceptedConsentIds: ids, serviceRegulamin: true }, { session })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.setCookie, null, 'a session already on the address needs no code')
  const regId = ok.body.data.registrationId
  const version = (await one('registration_settings', { event_id: event.eventId })).regulamin_version
  const acc = await rows('consent_acceptances', { registration_id: regId })
  assert.equal(acc.length, ids.length + 1)
  assert.deepEqual(acc.filter((x) => x.consent_id).map((x) => x.consent_id).sort(), [...ids].sort())
  assert.equal(acc.filter((x) => x.consent_kind === 'service_regulamin').length, 1)
  for (const x of acc) assert.equal(x.accepted_as, 'self')
  // The version rides on the regulamin acceptance, as register_free stores it.
  const regulamin = acc.filter((x) => x.consent_kind === 'regulamin')
  assert.equal(regulamin.length, 1)
  assert.equal(regulamin[0].regulamin_version, version)
  assert.ok(version != null)
})

// ---------------------------------------------------------------- V-58 the buyer's order after a transfer

test('V-58 the order page and a confirmation re-send show the line as transferred, by name only', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const third = runnerEmail('v58')
  const res = await acceptWithCode(event, inv.token, third)
  assert.equal(res.status, 200, res.text)

  const status = await call('order-status', { orderId: a.orderId }, { session: holder })
  assert.equal(status.status, 200, status.text)
  const [line] = status.body.data.lines
  assert.equal(line.transferred, true)
  assert.equal(line.name, 'Jan Nowak')
  assert.equal(line.role, null)
  assert.equal(line.consentState, null)
  assert.equal(line.mine, false)
  assert.ok(!status.text.includes(third), 'the recipient\'s address is never in the buyer\'s view')

  // A lost confirmation re-sent after the transfer (registration-jobs, P3-R10).
  await db().from('orders').update({ paid_at: new Date(Date.now() - 11 * 60_000).toISOString(), confirmation_sent_at: null }).eq('id', a.orderId)
  const jobs = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET }, body: '{}',
  })
  assert.equal(jobs.status, 200, await jobs.text())
  assert.ok((await orderOf(a.orderId)).confirmation_sent_at)
  const [mail] = await waitForMail(a.email, 1, bySubject(/^Opłacone — /))
  assert.ok(mail, 'the confirmation was re-sent to the buyer')
  assert.match(mail.text, /- Jan Nowak — przejął\(-ęła\) pakiet/)
  assert.ok(!`${mail.text}${mail.html}`.includes(third))
})

// ---------------------------------------------------------------- I-1 the job re-sends a released claim

async function runJobs() {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET }, body: '{}',
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.data
}

test('I-1 an accepted transfer whose e-mails certainly failed is re-sent once by registration-jobs, 10 minutes on', async () => {
  const { event, a, holder } = await holderOf()
  const inv = await invited(a, holder)
  const third = runnerEmail('i1')
  const res = await acceptWithCode(event, inv.token, third)
  assert.equal(res.status, 200, res.text)
  await waitForMail(third, 1, bySubject(/^Jesteś na liście/))
  // As the first send leaves it when it gave the claims back.
  await db().from('transfers').update({ accepted_emailed_at: null, confirmation_emailed_at: null }).eq('id', inv.transferId)

  await runJobs()
  assert.equal((await transferOf(inv.transferId)).accepted_emailed_at, null, 'not before 10 minutes')

  await db().from('transfers').update({ accepted_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq('id', inv.transferId)
  const first = await runJobs()
  assert.ok(first.transferEmailsResent >= 2, JSON.stringify(first))
  const t = await transferOf(inv.transferId)
  assert.ok(t.accepted_emailed_at && t.confirmation_emailed_at)
  assert.equal((await waitForMail(a.email, 2, bySubject(/^Pakiet przejęła/))).length, 2, 'the first send and the re-send')
  assert.equal((await waitForMail(third, 2, bySubject(/^Jesteś na liście/))).length, 2)

  await runJobs()
  await sleep(500)
  assert.equal((await messagesTo(a.email)).filter(bySubject(/^Pakiet przejęła/)).length, 2, 'never a third')
})

// ---------------------------------------------------------------- M-7 a guardian

test('M-7 a guardian asking to hand on a child\'s entry → 409 not_transferable, not 404', async () => {
  const event = await paidEvent()
  const guardianEmail = runnerEmail('guardian')
  const out = await orderGroupOk(event, [adult(event.categoryIds[0], 'self', guardianEmail), minor(event.categoryIds[1])])
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const child = (await rows('registrations', { order_id: out.orderId })).find((r) => !r.email)
  const guardian = await sessionFor(guardianEmail)
  assert.equal(child.guardian_profile_id, guardian.profileId)
  const res = await call('transfer-invite', { action: 'create', registrationId: child.id, toEmail: runnerEmail('x') }, { session: guardian })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'not_transferable')
  const status = await call('transfer-invite', { action: 'status', registrationId: child.id }, { session: guardian })
  assert.equal(status.body.data.allowed, false)
})

// ---------------------------------------------------------------- 8b I-1 RA5 on the order page

test('V-65 order-status: the buyer\'s own confirmed line carries the transfer block; a child\'s, another adult\'s and a pending order\'s do not', async () => {
  const event = await paidEvent()
  const buyerEmail = runnerEmail('ra5')
  const otherEmail = runnerEmail('ra5-adult')
  const out = await orderGroupOk(event, [
    adult(event.categoryIds[0], 'self', buyerEmail), adult(event.categoryIds[0], 'adult', otherEmail), minor(event.categoryIds[1]),
  ])
  const buyer = await sessionFor(buyerEmail)

  const pending = await call('order-status', { orderId: out.orderId }, { session: buyer })
  assert.equal(pending.status, 200, pending.text)
  for (const l of pending.body.data.lines) assert.equal(l.transfer, null, 'nothing to hand on before payment')

  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const until = (await one('registration_settings', { event_id: event.eventId })).transfer_until
  const read = async () => {
    const res = await call('order-status', { orderId: out.orderId }, { session: buyer })
    assert.equal(res.status, 200, res.text)
    return res.body.data.lines
  }
  let lines = await read()
  const own = lines.find((l) => l.mine)
  assert.deepEqual(own.transfer, { allowed: true, until, pending: null })
  for (const l of lines.filter((x) => !x.mine)) assert.equal(l.transfer, null, `${l.role}: never another person's transfer data`)

  // An open invite shows on the buyer's own line only.
  const toEmail = runnerEmail('ra5-to')
  const created = await call('transfer-invite', { action: 'create', registrationId: own.registrationId, toEmail }, { session: buyer })
  assert.equal(created.status, 201, created.text)
  lines = await read()
  assert.equal(lines.find((l) => l.mine).transfer.pending.toEmail, toEmail)
  assert.equal(lines.find((l) => l.mine).transfer.pending.transferId, created.body.data.transferId)

  // The other adult reads nothing of the order; the stranger keeps the 404.
  const other = await sessionFor(otherEmail)
  assert.equal((await call('order-status', { orderId: out.orderId }, { session: other })).status, 404)

  // After the last day: still on the line, no longer allowed.
  await setSettings(event.eventId, { transfer_until: dayBefore(warsawToday()) })
  lines = await read()
  assert.equal(lines.find((l) => l.mine).transfer.allowed, false)
})
