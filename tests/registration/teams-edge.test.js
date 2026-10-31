// Plan 5, task 5a: the register-team endpoint and its e-mails, and startPaymentAttempt under it.
// Scenarios T-40, T-41, T-44, T-45 and T-46 in docs/registration/scenario-matrix.md. LOCAL stack
// plus the mocked dpay; every event and address is random.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { lastCodeFor, messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, dpayTransactions, payMock, replayIpn, startDpayMock } from './helpers/dpayControl.js'
import { competitionOf, consentIds, db, one, orderOf, orderOk, rows, runnerEmail } from './helpers/orders.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { STAFETA, freeTeamEvent, paidTeamEvent, setLegOrder, teamName } from './helpers/teams.js'
import { BIEG } from './helpers/groups.js'
import { RETIRED_EMAIL_MESSAGE } from '../../supabase/functions/_shared/deletedEmails.js'
import {
  CAPTAIN_MESSAGE, MEMBERS_CONSENT_MESSAGE, TEAM_NAME_MESSAGE, teamSizeMessage,
} from '../../supabase/functions/_shared/registration/team.js'

const DUPLICATE = 'Ta osoba jest już zapisana na te zawody.'
const NAME_TAKEN = 'Ta nazwa drużyny jest już zajęta.'
const PENDING_ORDER = 'Masz już nieopłacone zgłoszenie na te zawody.'
const NO_PLACES = 'Brak wolnych miejsc dla drużyn.'
const DPAY_DOWN = 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie.'
const CONSENT_SUBJECT = /^Zapisano Cię na .+ — zaakceptuj regulamin$/
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

let owner, stopCapture, stopMock
before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

// A random documentation-range address per call keeps the per-IP throttles out of the way.
const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') }
}

const grownUp = (email, over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', ...over,
})
const child = (over = {}) => ({
  firstName: 'Zosia', lastName: 'Leśna', birthDate: '2016-05-05', gender: 'K', phone: '600100200', ...over,
})

/** The captain, one adult, two children (a surname of their own: two teams never share a child). */
const fourOf = (me, partner, surname = `Leśna${crypto.randomBytes(3).toString('hex')}`) => [
  { person: grownUp(me) },
  { person: grownUp(partner, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M' }) },
  { person: child({ lastName: surname }), guardianConsent: true },
  { person: child({ firstName: 'Staś', lastName: surname, gender: 'M' }), guardianConsent: true },
]

/** A register-team body for the event's first competition. */
async function teamBody(event, members, over = {}) {
  const categoryId = event.categoryIds[0]
  return {
    categoryId, teamName: teamName(), members, membersConsent: true,
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
    displayedTotal: event.prices?.[categoryId] ?? 0, ...over,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForMail(email, n = 1) {
  for (let i = 0; i < 40; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return messagesTo(email)
}
async function waitFor(check, what) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return
    await sleep(250)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const eventName = async (eventId) => (await one('registration_settings', { event_id: eventId })).name
const byEvent = (eventId) => rows('registrations', { event_id: eventId })
const teamsOf = (eventId) => rows('teams', { event_id: eventId })

/** A pending team through register-team → { event, me, partner, session, body, txn, ...data }. */
async function pendingTeam(opts = {}) {
  const event = opts.event ?? await paidTeamEvent(owner, opts.eventOpts)
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const session = await sessionFor(me)
  const body = await teamBody(event, fourOf(me, partner), opts.body)
  const r = await call('register-team', body, session)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const txn = (await dpayTransactions()).at(-1)
  return { event, me, partner, session, body, txn, ...r.body.data }
}

// ---------------------------------------------------------------- T-40 free

test('T-40 a free team: 201 with no order; one confirmation to the captain with the four members and the squad link; one consent e-mail to the adult; none for the children', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const body = await teamBody(event, fourOf(me, partner, 'Leśna'))
  const r = await call('register-team', body, await sessionFor(me))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(Object.keys(r.body.data).sort(), ['status', 'teamId'])
  assert.equal(r.body.data.status, 'confirmed')
  const { teamId } = r.body.data

  const regs = await byEvent(event.eventId)
  assert.equal(regs.length, 4)
  assert.ok(regs.every((x) => x.team_id === teamId && x.status === 'confirmed' && x.order_id === null))
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])

  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Drużyna ${body.teamName} jest na liście — ${name}`])
  for (const part of ['Ola Leśna', 'Piotr Borowy', 'Zosia Leśna', 'Staś Leśna', 'opiekun: kapitan', 'Zarządzaj składem']) {
    assert.ok(mine[0].text.includes(part), part)
  }
  const { slug } = await one('registration_settings', { event_id: event.eventId })
  assert.match(mine[0].text, new RegExp(`/events/${slug}/druzyna/${teamId}\\b`))
  assert.doesNotMatch(mine[0].text, /Opłacone|Razem|paragonem|numer startowy/i)

  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1)
  assert.match(asked[0].subject, CONSENT_SUBJECT)
  assert.ok(asked[0].text.includes(`w drużynie ${body.teamName}`))
  assert.ok(asked[0].text.includes('Ola Leśna zapisał(a) Cię'))
  await sleep(300)
  assert.equal((await messagesTo(me)).length, 1, 'the captain gets no consent e-mail')
  assert.equal((await rows('consent_requests', {})).filter((c) => regs.some((x) => x.id === c.registration_id)).length, 1)
})

test('T-40 a 0 zł fee on a paid event is confirmed at once, never reaches dpay, and the confirmation has no payment wording (P3-R9, D5-23)', async () => {
  const event = await paidTeamEvent(owner, { price: 0 })
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const body = await teamBody(event, fourOf(me, partner))
  const r = await call('register-team', body, await sessionFor(me))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'confirmed')
  assert.ok(r.body.data.orderId, 'a 0 zł team on a paid event has an order')
  assert.equal(r.body.data.redirectUrl, undefined)
  assert.deepEqual(await dpayTransactions(), [])
  assert.equal((await orderOf(r.body.data.orderId)).status, 'paid')

  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Drużyna ${body.teamName} jest na liście — ${name}`])
  assert.doesNotMatch(mine[0].text, /Razem|paragonem|Transakcja/)
  assert.ok((await orderOf(r.body.data.orderId)).confirmation_sent_at)
  assert.equal((await waitForMail(partner)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
})

// ---------------------------------------------------------------- T-41 paid

test('T-41 a paid team: nothing while pending; paid → the team confirmation with the payment facts and one consent e-mail; a replayed IPN ×3 → still one each', async () => {
  const { event, me, partner, body, txn, orderId, teamId, redirectUrl } = await pendingTeam()
  assert.ok(redirectUrl)
  assert.ok(teamId)
  const order = await orderOf(orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.total, 24000)
  assert.equal(txn.grosze, 24000)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
  await sleep(500)
  assert.deepEqual(await messagesTo(partner), [], 'no consent e-mail while the team waits for payment')
  assert.deepEqual(await messagesTo(me), [])

  await payMock(txn.id, 'paid')
  await waitFor(async () => (await orderOf(orderId)).status === 'paid', 'payment')
  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Drużyna ${body.teamName} jest na liście — ${name}`])
  for (const part of ['Piotr Borowy', 'opiekun: kapitan', 'Zarządzaj składem', 'Razem', 'w imieniu i na rzecz Organizatora', 'nie jest paragonem']) {
    assert.ok(mine[0].text.includes(part), part)
  }
  assert.ok(mine[0].text.includes(`/druzyna/${teamId}`))
  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1)
  assert.match(asked[0].subject, CONSENT_SUBJECT)
  assert.ok(asked[0].text.includes(`w drużynie ${body.teamName}`))
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])

  for (let i = 0; i < 3; i++) await replayIpn(txn.id, { times: 1 })
  await sleep(1000)
  assert.equal((await messagesTo(me)).length, 1, 'one confirmation')
  assert.equal((await messagesTo(partner)).length, 1, 'one consent e-mail')
})

test('T-41 a paid team refunded for full: no confirmation, no consent e-mail, the refund e-mail, the whole fee back, the name free', async () => {
  const event = await paidTeamEvent(owner, { capacity: 1 })
  const first = await pendingTeam({ event })
  const late = await pendingTeam({ event })

  await payMock(first.txn.id, 'paid')
  await waitFor(async () => (await orderOf(first.orderId)).status === 'paid', 'the first payment')
  await payMock(late.txn.id, 'paid')
  await waitFor(async () => (await dpayRefunds()).some((x) => x.txnId === late.txn.id), 'the refund')

  assert.equal((await orderOf(late.orderId)).status, 'cancelled')
  const subjects = (await waitForMail(late.me)).map((m) => m.subject)
  assert.equal(subjects.length, 1)
  assert.match(subjects[0], /^Płatność zwrócona — /)
  await sleep(500)
  assert.deepEqual(await messagesTo(late.partner), [])
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])
  assert.ok((await one('teams', { id: late.teamId })).released_at)
})

test('T-41 D5-25 a lost team confirmation is resent by registration-jobs as the same team e-mail', async () => {
  const { me, partner, body, txn, orderId, event } = await pendingTeam()
  await payMock(txn.id, 'paid')
  await waitFor(async () => (await orderOf(orderId)).confirmation_sent_at !== null, 'the confirmation')
  await waitForMail(partner)
  await db().from('orders')
    .update({ confirmation_sent_at: null, paid_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq('id', orderId)

  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET },
    body: '{}',
  })
  assert.equal(res.status, 200, await res.text())
  const mine = await waitForMail(me, 2)
  const name = await eventName(event.eventId)
  assert.deepEqual(mine.map((m) => m.subject), Array(2).fill(`Drużyna ${body.teamName} jest na liście — ${name}`))
})

// ---------------------------------------------------------------- T-44 refusals

test('T-44 team_name_taken → 409 with fields.teamName, a paid team too, in another spelling; nothing is written', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const name = teamName()
  const ok = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { teamName: name }), await sessionFor(me))
  assert.equal(ok.status, 201, JSON.stringify(ok.body))

  const other = runnerEmail('capt')
  const r = await call('register-team', await teamBody(event, fourOf(other, runnerEmail('adult')), { teamName: `  ${name.toUpperCase()} ` }), await sessionFor(other))
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: NAME_TAKEN, code: 'team_name_taken', fields: { teamName: NAME_TAKEN } })
  assert.equal((await byEvent(event.eventId)).length, 4)
  assert.equal((await teamsOf(event.eventId)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)

  const paid = await pendingTeam({ eventOpts: {} })
  const third = runnerEmail('capt')
  const taken = await call('register-team', await teamBody(paid.event, fourOf(third, runnerEmail('adult')), { teamName: paid.body.teamName }), await sessionFor(third))
  assert.equal(taken.status, 409, JSON.stringify(taken.body))
  assert.equal(taken.body.code, 'team_name_taken', 'somebody else\'s pending team keeps its name')
})

test('T-44 duplicate:2 → errors[2].email, and past the daily cap the answer names nobody', async () => {
  const event = await freeTeamEvent(owner)
  const dup = runnerEmail('dup')
  const first = runnerEmail('capt')
  assert.equal((await call('register-team', await teamBody(event, [{ person: grownUp(first) }, { person: grownUp(dup) }]), await sessionFor(first))).status, 201)

  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const members = [{ person: grownUp(me) }, { person: grownUp(runnerEmail('adult')) }, { person: grownUp(dup) }]
  const r = await call('register-team', await teamBody(event, members), session)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: DUPLICATE, code: 'duplicate', index: 2, errors: { 2: { email: DUPLICATE } } })
  assert.equal((await teamsOf(event.eventId)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)

  for (let i = 0; i < 4; i++) await call('register-team', await teamBody(event, members), session)
  const capped = await call('register-team', await teamBody(event, members), session)
  assert.equal(capped.status, 409)
  assert.equal(capped.body.code, 'refused')
  assert.equal(capped.body.errors, undefined)
})

test('T-44 full → „Brak wolnych miejsc dla drużyn.”, free and paid', async () => {
  const free = await freeTeamEvent(owner, { capacity: 1 })
  const a = runnerEmail('capt')
  assert.equal((await call('register-team', await teamBody(free, fourOf(a, runnerEmail('adult'))), await sessionFor(a))).status, 201)
  const b = runnerEmail('capt')
  const r = await call('register-team', await teamBody(free, fourOf(b, runnerEmail('adult'))), await sessionFor(b))
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: NO_PLACES, code: 'full' })

  const paid = await paidTeamEvent(owner, { capacity: 1 })
  const one1 = await pendingTeam({ event: paid })
  await payMock(one1.txn.id, 'paid')
  await waitFor(async () => (await orderOf(one1.orderId)).status === 'paid', 'payment')
  const c = runnerEmail('capt')
  const p = await call('register-team', await teamBody(paid, fourOf(c, runnerEmail('adult'))), await sessionFor(c))
  assert.equal(p.status, 409, JSON.stringify(p.body))
  assert.deepEqual(p.body, { error: NO_PLACES, code: 'full' })
})

test('T-44 consents, price and window: consents_changed, price_changed with the amounts, too_many_pending, closed and not_open, paying_closed', async () => {
  const event = await paidTeamEvent(owner)
  const me = runnerEmail('capt')
  const session = await sessionFor(me)

  const noConsents = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { acceptedConsentIds: [] }), session)
  assert.equal(noConsents.status, 400)
  assert.equal(noConsents.body.error, 'Zaznacz wymagane zgody.')

  const changed = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { displayedTotal: 23999 }), session)
  assert.equal(changed.status, 409, JSON.stringify(changed.body))
  assert.equal(changed.body.code, 'price_changed')
  assert.deepEqual(changed.body.amounts, { entryPrices: [24000], entryTotal: 24000, extrasTotal: 0, donation: 0, total: 24000 })

  const bad = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { displayedTotal: -1 }), session)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'invalid_total')

  // Two pending orders of this account, none of them this squad.
  const buyer = runnerEmail('buyer')
  const two = await paidTeamEvent(owner, { competitions: [STAFETA(), BIEG()], prices: { Sztafeta: 24000, 'Bieg 9 km': 6000 } })
  await orderOk(two, { categoryId: two.categoryIds[1], emails: [runnerEmail('r')], buyerEmail: buyer })
  await orderOk(two, { categoryId: two.categoryIds[1], emails: [runnerEmail('r')], buyerEmail: buyer })
  const tooMany = await call('register-team', await teamBody(two, fourOf(buyer, runnerEmail('adult'))), await sessionFor(buyer))
  assert.equal(tooMany.status, 409, JSON.stringify(tooMany.body))
  assert.equal(tooMany.body.code, 'too_many_pending')
  assert.equal(tooMany.body.error, 'Masz już dwa nieopłacone zgłoszenia na te zawody.')

  const closing = await paidTeamEvent(owner)
  await db().from('registration_settings').update({ closes_at: new Date(Date.now() + 30 * 60_000).toISOString() }).eq('event_id', closing.eventId)
  const late = await call('register-team', await teamBody(closing, fourOf(me, runnerEmail('adult'))), session)
  assert.equal(late.status, 409, JSON.stringify(late.body))
  assert.equal(late.body.code, 'paying_closed')

  const closed = await paidTeamEvent(owner)
  await db().from('registration_settings').update({ closes_at: new Date(Date.now() - 1000).toISOString() }).eq('event_id', closed.eventId)
  const shut = await call('register-team', await teamBody(closed, fourOf(me, runnerEmail('adult'))), session)
  assert.equal(shut.status, 409)
  assert.deepEqual(shut.body, { error: 'Zapisy są zamknięte.', code: 'closed' })

  const soon = await paidTeamEvent(owner)
  await db().from('registration_settings').update({ opens_at: new Date(Date.now() + 3600_000).toISOString() }).eq('event_id', soon.eventId)
  const early = await call('register-team', await teamBody(soon, fourOf(me, runnerEmail('adult'))), session)
  assert.equal(early.status, 409)
  assert.deepEqual(early.body, { error: 'Zapisy jeszcze się nie rozpoczęły.', code: 'not_open' })
  assert.equal((await byEvent(event.eventId)).length, 0)
})

// ---------------------------------------------------------------- T-45 the request

test('T-45 who registers: no session and no code → 401; the e-mail code logs the captain in and sets the cookie; the honeypot writes nothing; the captain must be the address that logs in', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const members = fourOf(me, runnerEmail('adult'))
  const r = await call('register-team', await teamBody(event, members))
  assert.equal(r.status, 401, JSON.stringify(r.body))
  assert.equal(r.body.code, 'code_required')
  assert.equal((await byEvent(event.eventId)).length, 0)

  const asOther = await call('register-team', await teamBody(event, members), await sessionFor(runnerEmail('other')))
  assert.equal(asOther.status, 401, JSON.stringify(asOther.body))

  const bot = await call('register-team', await teamBody(event, members, { website: 'https://spam.example' }), await sessionFor(me))
  assert.equal(bot.status, 200, JSON.stringify(bot.body))
  assert.equal(bot.body.data, undefined)
  assert.equal((await byEvent(event.eventId)).length, 0)

  const res = await fetch(`${localEnv().functionsUrl}/auth-request-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: me }),
  })
  assert.equal(res.status, 200)
  let code = null
  for (let i = 0; i < 20 && !code; i++) { code = await lastCodeFor(me); if (!code) await sleep(250) }
  const signed = await call('register-team', await teamBody(event, members, { code }))
  assert.equal(signed.status, 201, JSON.stringify(signed.body))
  assert.match(signed.setCookie ?? '', /HttpOnly/i)
})

test('T-45 validateTeam answers: name and consent under fields, a minor captain, a member\'s field under errors, the squad size, an individual competition', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const members = fourOf(me, runnerEmail('adult'))

  const name = await call('register-team', await teamBody(event, members, { teamName: 'x', membersConsent: false }), session)
  assert.equal(name.status, 400)
  assert.equal(name.body.code, 'invalid_person')
  assert.deepEqual(name.body.fields, { teamName: TEAM_NAME_MESSAGE, membersConsent: MEMBERS_CONSENT_MESSAGE })

  const minor = await call('register-team', await teamBody(event, [
    { person: grownUp(me, { birthDate: '2015-01-01' }), guardianConsent: true }, members[1],
  ]), session)
  assert.equal(minor.status, 400)
  assert.equal(minor.body.code, 'invalid_group')
  assert.equal(minor.body.error, CAPTAIN_MESSAGE)

  const noConsent = await call('register-team', await teamBody(event, [members[0], members[1], { person: child() }]), session)
  assert.equal(noConsent.status, 400)
  assert.equal(noConsent.body.code, 'invalid_person')
  assert.deepEqual(noConsent.body.errors, { 2: { guardianConsent: 'Zaznacz zgodę opiekuna.' } })

  const alone = await call('register-team', await teamBody(event, [members[0]]), session)
  assert.equal(alone.status, 400)
  assert.equal(alone.body.code, 'invalid_group')
  assert.equal(alone.body.error, teamSizeMessage(2, 6))

  const solo = await freeTeamEvent(owner, { competitions: [BIEG()] })
  const notTeam = await call('register-team', await teamBody(solo, members), session)
  assert.equal(notTeam.status, 409, JSON.stringify(notTeam.body))
  assert.equal(notTeam.body.code, 'not_team')

  const unknown = await call('register-team', await teamBody(event, members, { categoryId: crypto.randomUUID() }), session)
  assert.equal(unknown.status, 404)
  assert.equal((await byEvent(event.eventId)).length, 0)
})

test('T-45 leg order: legs are stored when on, refused when not 1…n; a retired member → 403 with their index, only to a verified captain', async () => {
  const event = await freeTeamEvent(owner, { legOrder: true })
  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const partner = runnerEmail('adult')
  const noLegs = await call('register-team', await teamBody(event, [{ person: grownUp(me) }, { person: grownUp(partner) }]), session)
  assert.equal(noLegs.status, 400)
  assert.equal(noLegs.body.error, 'Ustal kolejność zmian.')
  const ok = await call('register-team', await teamBody(event, [{ person: grownUp(me), leg: 2 }, { person: grownUp(partner), leg: 1 }]), session)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  const regs = await byEvent(event.eventId)
  assert.equal(regs.find((x) => x.email === me).team_leg, 2)
  assert.equal(regs.find((x) => x.email === partner).team_leg, 1)

  const other = await freeTeamEvent(owner)
  await setLegOrder(other.categoryIds[0], false)
  const gone = runnerEmail('gone')
  const hash = crypto.createHash('sha256').update(gone).digest('hex')
  assert.ifError((await db().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })).error)
  const members = [{ person: grownUp(me) }, { person: grownUp(gone) }]
  const anon = await call('register-team', await teamBody(other, members))
  assert.equal(anon.status, 401)
  const r = await call('register-team', await teamBody(other, members), session)
  assert.equal(r.status, 403, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: RETIRED_EMAIL_MESSAGE, code: 'email_retired', index: 1 })
  assert.equal((await byEvent(other.eventId)).length, 0)
})

test('T-45 D5-24 a captain\'s resubmit while their team waits for payment → 409 pending_order with its id, under the same name and under another; nothing new is written', async () => {
  const { event, me, partner, session, body, orderId } = await pendingTeam()
  const same = await call('register-team', body, session)
  assert.equal(same.status, 409, JSON.stringify(same.body))
  assert.deepEqual(same.body, { error: PENDING_ORDER, code: 'pending_order', orderId })

  const renamed = await call('register-team', await teamBody(event, fourOf(me, partner)), session)
  assert.equal(renamed.status, 409, JSON.stringify(renamed.body))
  assert.deepEqual(renamed.body, { error: PENDING_ORDER, code: 'pending_order', orderId })
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 1)
  assert.equal((await teamsOf(event.eventId)).length, 1)
})

test('T-45 D5-24 dpay refuses the registration → 502, the order cancelled with its reason, the name free, and the captain can sign up again', async () => {
  const event = await paidTeamEvent(owner)
  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const body = await teamBody(event, fourOf(me, runnerEmail('adult')))
  await dpayMode({ registerFails: true })
  const r = await call('register-team', body, session)
  assert.equal(r.status, 502, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: DPAY_DOWN, code: 'dpay_unavailable' })
  const [order] = await rows('orders', { event_id: event.eventId })
  assert.equal(order.status, 'cancelled')
  assert.equal(order.cancelled_reason, 'dpay_register_failed')
  assert.ok((await teamsOf(event.eventId))[0].released_at, 'the name is free again')
  const logged = await rows('payment_events', { order_id: order.id })
  assert.equal(logged.filter((e) => e.kind === 'register' && e.payload.ok === false).length, 1)

  await dpayReset()
  const again = await call('register-team', body, session)
  assert.equal(again.status, 201, JSON.stringify(again.body))
})

test('T-45 D5-24 pay-order on a team order: a new transaction at the frozen fee; a dpay failure leaves the order pending', async () => {
  const { orderId, session } = await pendingTeam()
  await dpayMode({ registerFails: true })
  const down = await call('pay-order', { orderId }, session)
  assert.equal(down.status, 502, JSON.stringify(down.body))
  assert.deepEqual(down.body, { error: DPAY_DOWN, code: 'dpay_unavailable' })
  const order = await orderOf(orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.cancelled_reason, null)

  await dpayMode({ registerFails: false })
  const r = await call('pay-order', { orderId }, session)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.data.redirectUrl)
  assert.equal((await rows('payment_attempts', { order_id: orderId })).length, 2)
  assert.equal((await dpayTransactions()).at(-1).grosze, 24000)
})
