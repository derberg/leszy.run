// Runner self-service, task 13: the runner's own endpoint my-entry-action (targets, change, edit)
// end to end through the served function, the mocked dpay and the e-mail capture server.
// Who may act: the entry's profile, a session for the entry's address (an adult entry), a child's
// guardian; anybody else 404. Scenarios RS-10… in docs/registration/scenario-matrix.md. LOCAL only.
import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import { attemptFor, confirmOk, db, one, person, profileFor, rows, runnerEmail, setSettings } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, orderGroupOk } from './helpers/groups.js'
import { captain, freeTeamEvent, teamOk } from './helpers/teams.js'
import { nodeDpay } from './helpers/organizerRefund.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { registerTransaction } from '../../supabase/functions/_shared/dpay.js'

const OWNER = 'owner@zatyrani-test.local'
const C5 = { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 50 }
const C21 = { name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity: 50 }

let owner, stopCapture, stopMock
const competitionsSeen = new Set()

before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor(OWNER)
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })
afterEach(async () => {
  const competitions = [...competitionsSeen]
  competitionsSeen.clear()
  for (const id of competitions) await assertSlotInvariant(id)
})

const key = () => crypto.randomUUID()
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const act = (session, body) => callFn('my-entry-action', session, body)
const targets = (session, registrationId) => act(session, { action: 'targets', registrationId })
const change = (session, registrationId, categoryId, expectedDifference, extra = {}) =>
  act(session, { action: 'change', registrationId, categoryId, expectedDifference, requestKey: key(), ...extra })
const edit = (session, registrationId, fields) => act(session, { action: 'edit', registrationId, fields })
const reg = (id) => one('registrations', { id })
const changesOf = (registrationId) => rows('registration_changes', { registration_id: registrationId })

/** 9 km 60 zł, 5 km 40 zł, 21 km 80 zł, kids 20 zł; its own contact address so its club mail can be read. */
async function paidEvent() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), C5, C21, DZIECI()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000, 'Bieg 21 km': 8000, 'Bieg dzieci 1 km': 2000 },
  })
  event.categoryIds.forEach((c) => competitionsSeen.add(c))
  event.contact = `club-${crypto.randomBytes(4).toString('hex')}@test.local`
  await setSettings(event.eventId, { contact_email: event.contact })
  return event
}

/** An order the mock holds as paid (so dpay can refund it) → { orderId, regs }. */
async function paidOrder(event, people, opts) {
  const out = await orderGroupOk(event, people, opts)
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: out.orderId, grosze: out.total })
  await attemptFor(out.orderId, out.total, transactionId)
  await dpayMode({ dropIpn: true })
  await payMock(transactionId, 'paid')
  await dpayMode({ dropIpn: false })
  assert.equal((await confirmOk(out.orderId, transactionId, out.total)).outcome, 'confirmed')
  return { orderId: out.orderId, regs: await rows('registrations', { order_id: out.orderId }) }
}

/** The runner's own paid entry in 9 km → { registrationId, orderId, email, session }. */
async function ownEntry(event, { email = runnerEmail('self') } = {}) {
  const { orderId, regs } = await paidOrder(event, [adult(event.categoryIds[0], 'self', email)])
  return { registrationId: regs[0].id, orderId, email, session: await sessionFor(email) }
}

async function waitForMail(email, n, { subject } = {}) {
  const pick = async () => (await messagesTo(email)).filter((m) => !subject || m.subject.startsWith(subject))
  for (let i = 0; i < 40; i++) {
    const msgs = await pick()
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return pick()
}

// The organizer's own audit of a change or an edit (organizer-entry-action) never records a runner's.
const CHANGE_ACTIONS = ['competition_changed', 'surcharge_created', 'refund_settled', 'registration_edited']
const noOrganizerActions = async (eventId) => assert.deepEqual(
  (await rows('organizer_actions', { event_id: eventId })).filter((a) => CHANGE_ACTIONS.includes(a.action)), [],
  'a runner action is never an organizer action')

// ---------------------------------------------------------------- RS-10 who

test('RS-10 401 without a session; a stranger, the payer of an added adult and an unknown id get the same 404', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const buyer = runnerEmail('buyer')
  const added = runnerEmail('added')
  const { regs } = await paidOrder(event, [adult(c9, 'self', buyer), adult(c9, 'adult', added)])
  const addedReg = regs.find((r) => r.email === added)

  assert.equal((await act(null, { action: 'targets', registrationId: addedReg.id })).status, 401)
  const stranger = await sessionFor(runnerEmail('stranger'))
  const payer = await sessionFor(buyer)
  const unknown = await targets(stranger, crypto.randomUUID())
  assert.equal(unknown.status, 404)
  for (const s of [stranger, payer]) {
    for (const body of [
      { action: 'targets', registrationId: addedReg.id },
      { action: 'change', registrationId: addedReg.id, categoryId: c5, expectedDifference: -2000, requestKey: key() },
      { action: 'edit', registrationId: addedReg.id, fields: { city: 'Szubin' } },
    ]) {
      const r = await act(s, body)
      assert.equal(r.status, 404, `${body.action}: ${JSON.stringify(r.body)}`)
      assert.deepEqual(r.body, unknown.body)
    }
  }
  assert.equal((await act(stranger, { action: 'nope', registrationId: addedReg.id })).status, 400)
  assert.equal((await reg(addedReg.id)).category_id, c9)
})

test('RS-10 a disabled club: 404 even for the holder', async () => {
  const event = await paidEvent()
  const e = await ownEntry(event)
  const { error } = await db().from('clubs').update({ registration_enabled: false }).eq('slug', 'zatyrani-test')
  if (error) throw error
  try {
    assert.equal((await targets(e.session, e.registrationId)).status, 404)
    assert.equal((await edit(e.session, e.registrationId, { city: 'Szubin' })).status, 404)
  } finally {
    const { error: back } = await db().from('clubs').update({ registration_enabled: true }).eq('slug', 'zatyrani-test')
    if (back) throw back
  }
})

test('RS-10 a draft event: 404 for every action, even for the holder', async () => {
  const event = await paidEvent()
  const e = await ownEntry(event)
  await setSettings(event.eventId, { state: 'draft' })
  for (const body of [
    { action: 'targets', registrationId: e.registrationId },
    { action: 'details', registrationId: e.registrationId },
    { action: 'change', registrationId: e.registrationId, categoryId: event.categoryIds[1], expectedDifference: -2000, requestKey: key() },
    { action: 'edit', registrationId: e.registrationId, fields: { city: 'Szubin' } },
  ]) {
    const r = await act(e.session, body)
    assert.deepEqual([r.status, r.body], [404, { error: 'Not found' }], body.action)
  }
  await setSettings(event.eventId, { state: 'published' })
  assert.equal((await reg(e.registrationId)).category_id, event.categoryIds[0])
})

test('RS-10 an entry no longer live, reached through the address: targets allowed false (not_live), edit 409', async () => {
  const event = await paidEvent()
  // cancelled by the club
  const a = await ownEntry(event)
  const cancelled = await callFn('organizer-entry-action', owner, { action: 'cancel', registrationId: a.registrationId })
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  // moved to somebody else by the club (transferred_out)
  const b = await ownEntry(event)
  const moved = await callFn('organizer-entry-action', owner, {
    action: 'transfer', registrationId: b.registrationId, categoryId: event.categoryIds[0],
    person: (({ ageGroupLabel: _l, ...p }) => p)(person(runnerEmail('nowy'), { firstName: 'Jan', lastName: 'Nowak', gender: 'M' })),
  })
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  for (const [e, status] of [[a, 'cancelled'], [b, 'transferred_out']]) {
    const row = await reg(e.registrationId)
    assert.equal(row.status, status)
    // The address alone reaches it (the check does not depend on the profile).
    await db().from('registrations').update({ profile_id: null }).eq('id', e.registrationId)
    const t = await targets(e.session, e.registrationId)
    assert.equal(t.status, 200, JSON.stringify(t.body))
    assert.deepEqual([t.body.data.allowed, t.body.data.refusal, t.body.data.targets], [false, 'not_live', []], status)
    const ed = await edit(e.session, e.registrationId, { city: 'Szubin' })
    assert.deepEqual([ed.status, ed.body.code], [409, 'not_live'], `${status}: ${JSON.stringify(ed.body)}`)
    assert.equal((await reg(e.registrationId)).city, row.city)
  }
})

// ---------------------------------------------------------------- RS-11 targets

test('RS-11 targets: the holder by profile sees prices and the club switches; switch off → allowed false, no targets', async () => {
  const event = await paidEvent()
  const [, c5, c21, kids] = event.categoryIds
  const { error: ageErr } = await db().from('competitions').update({ max_age: 14 }).eq('category_id', kids)
  if (ageErr) throw ageErr
  const e = await ownEntry(event)
  const r = await targets(e.session, e.registrationId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const d = r.body.data
  assert.equal(d.allowed, true)
  assert.equal(d.competitionChange, true)
  assert.equal(d.dataEdit, true)
  assert.equal(typeof d.closesAt, 'string')
  assert.equal(d.entry.held, 6000)
  const byId = new Map(d.targets.map((t) => [t.categoryId, t]))
  assert.deepEqual([byId.get(c5).difference, byId.get(c5).kind], [-2000, 'refund'])
  assert.deepEqual([byId.get(c21).difference, byId.get(c21).kind], [2000, 'surcharge'])
  assert.equal(byId.get(kids).eligible, false)

  await setSettings(event.eventId, { runner_competition_change: false })
  const off = await targets(e.session, e.registrationId)
  assert.equal(off.status, 200)
  assert.deepEqual([off.body.data.allowed, off.body.data.competitionChange, off.body.data.dataEdit, off.body.data.targets],
    [false, false, true, []])
  assert.equal(off.body.data.refusal, 'not_allowed')
  const refused = await change(e.session, e.registrationId, c5, -2000)
  assert.deepEqual([refused.status, refused.body.code], [403, 'not_allowed'])
  assert.equal(refused.body.error, 'Organizator nie zezwala na tę zmianę.')

  await setSettings(event.eventId, { runner_data_edit: false })
  const noEdit = await edit(e.session, e.registrationId, { city: 'Szubin' })
  assert.deepEqual([noEdit.status, noEdit.body.code], [403, 'not_allowed'])
  assert.deepEqual(await changesOf(e.registrationId), [])
})

// ---------------------------------------------------------------- RS-12 change

test('RS-12 change: same price moves, cheaper refunds through dpay, dearer bills the runner; club e-mail each; audit in registration_changes only', async () => {
  const event = await paidEvent()
  const [c9, c5, c21] = event.categoryIds

  // cheaper: 9 km → 5 km, 20 zł back
  const a = await ownEntry(event)
  const ra = await change(a.session, a.registrationId, c5, -2000)
  assert.equal(ra.status, 200, JSON.stringify(ra.body))
  assert.deepEqual([ra.body.data.outcome, ra.body.data.status, ra.body.data.moved], ['refund', 'accepted', true])
  assert.equal((await reg(a.registrationId)).category_id, c5)
  assert.equal((await dpayRefunds()).length, 1)
  let [row] = await changesOf(a.registrationId)
  assert.deepEqual([row.kind, row.from_category_id, row.to_category_id, row.grosze], ['competition', c9, c5, -2000])
  let club = await waitForMail(event.contact, 1, { subject: 'Zawodnik zmienił zgłoszenie' })
  assert.equal(club.length, 1)
  assert.ok(club[0].subject.endsWith(`— ${(await one('registration_settings', { event_id: event.eventId })).name}`), club[0].subject)
  assert.match(club[0].text, /Bieg 9 km/)
  assert.match(club[0].text, /Bieg 5 km/)
  assert.match(club[0].text, /20,00 zł/)
  assert.match(club[0].text, new RegExp(`/klub/zatyrani-test/wydarzenia/${event.eventId}/zgloszenia`))

  // same price: 5 km → 5 km is no move; set 21 km to 60 zł and move a fresh 9 km entry there
  const { error } = await db().from('competition_prices').update({ amount: 6000 }).eq('category_id', c21)
  if (error) throw error
  const b = await ownEntry(event)
  const rb = await change(b.session, b.registrationId, c21, 0)
  assert.deepEqual([rb.status, rb.body.data?.outcome], [200, 'moved'], JSON.stringify(rb.body))
  ;[row] = await changesOf(b.registrationId)
  assert.equal(row.grosze, 0)
  const { error: back } = await db().from('competition_prices').update({ amount: 8000 }).eq('category_id', c21)
  if (back) throw back

  // dearer: an added adult signs in with the entry's address and pays the surcharge themselves
  const buyer = runnerEmail('buyer')
  const addedEmail = runnerEmail('added')
  const { regs } = await paidOrder(event, [adult(c9, 'self', buyer), adult(c9, 'adult', addedEmail, { firstName: 'Piotr', lastName: 'Dodany' })])
  const added = regs.find((r) => r.email === addedEmail)
  assert.equal(added.profile_id, null)
  const addedSession = await sessionFor(addedEmail)
  const rc = await change(addedSession, added.id, c21, 2000)
  assert.equal(rc.status, 200, JSON.stringify(rc.body))
  assert.equal(rc.body.data.outcome, 'surcharge')
  const order = await one('orders', { id: rc.body.data.orderId })
  assert.deepEqual([order.buyer_email, order.buyer_profile_id, order.total], [addedEmail, addedSession.profileId, 2000])
  assert.equal((await waitForMail(addedEmail, 1, { subject: 'Dopłata' })).length, 1)
  club = await waitForMail(event.contact, 3, { subject: 'Zawodnik zmienił zgłoszenie' })
  assert.equal(club.length, 3)
  assert.ok(club.some((m) => /Piotr Dodany/.test(m.text) && /dopłat/i.test(m.text)), club.map((m) => m.text).join('\n---\n'))
  assert.equal((await waitForMail(buyer, 1, { subject: 'Dopłata' })).length, 0, 'the original buyer is not billed')

  await noOrganizerActions(event.eventId)
})

test('RS-12 change: an entry paid outside LESZY.RUN cannot go cheaper by the runner (offline_paid, no ack)', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const email = runnerEmail('offline')
  const out = await orderGroupOk(event, [adult(event.categoryIds[0], 'self', email)])
  const marked = await callFn('organizer-entry-action', owner, { action: 'mark_paid_offline', orderId: out.orderId, note: 'gotówka' })
  assert.equal(marked.status, 200, JSON.stringify(marked.body))
  const [offlineReg] = await rows('registrations', { order_id: out.orderId })
  const e = { registrationId: offlineReg.id, session: await sessionFor(email) }
  const t = await targets(e.session, e.registrationId)
  const t5 = t.body.data.targets.find((x) => x.categoryId === c5)
  assert.deepEqual([t5.eligible, t5.reason, t5.offlineAck], [false, 'offline_paid', undefined])
  const r = await change(e.session, e.registrationId, c5, -2000, { offlineAck: true })
  assert.deepEqual([r.status, r.body.code], [409, 'offline_paid'])
  assert.equal((await reg(e.registrationId)).category_id, event.categoryIds[0])
})

// ---------------------------------------------------------------- RS-13 edit

test('RS-13 edit: birth date re-derives, names and e-mail refused, guardian edits the child, club e-mail names the fields', async () => {
  const event = await paidEvent()
  const [c9, , , kids] = event.categoryIds
  const buyer = runnerEmail('parent')
  const { regs } = await paidOrder(event, [adult(c9, 'self', buyer), minor(kids)])
  const own = regs.find((r) => r.email === buyer)
  const child = regs.find((r) => r.email == null)
  const parent = await sessionFor(buyer)

  const r = await edit(parent, own.id, { birthDate: '1985-03-04', city: 'Szubin' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.changed, true)
  assert.equal((await reg(own.id)).birth_date, '1985-03-04')
  const [row] = await changesOf(own.id)
  assert.deepEqual([row.kind, [...row.fields].sort()], ['data', ['birthDate', 'city']])

  for (const fields of [{ firstName: 'Ala' }, { lastName: 'Nowak' }, { email: 'x@test.local' }]) {
    const no = await edit(parent, own.id, fields)
    assert.deepEqual([no.status, no.body.code], [422, 'field_not_allowed'], JSON.stringify(no.body))
    assert.ok(no.body.fields[Object.keys(fields)[0]])
  }
  const bad = await edit(parent, own.id, { birthDate: 'not-a-date' })
  assert.equal(bad.status, 422)
  assert.ok(bad.body.fields.birthDate)

  // The guardian edits the child's entry; a child cannot become an adult.
  const g = await edit(parent, child.id, { city: 'Nakło' })
  assert.equal(g.status, 200, JSON.stringify(g.body))
  assert.equal((await reg(child.id)).city, 'Nakło')
  const grown = await edit(parent, child.id, { birthDate: '1990-01-01' })
  assert.ok([409, 422].includes(grown.status), JSON.stringify(grown.body))
  assert.ok(['role_change', 'ineligible'].includes(grown.body.code))

  const club = await waitForMail(event.contact, 2, { subject: 'Zawodnik zmienił zgłoszenie' })
  assert.equal(club.length, 2)
  assert.ok(club.some((m) => /Data urodzenia/.test(m.text) && /Miejscowość/.test(m.text)))
  await noOrganizerActions(event.eventId)
})

test('RS-13 a team: the captain edits their own data but cannot change competition; a member gets 404 for both', async () => {
  const event = await freeTeamEvent(owner)
  event.categoryIds.forEach((c) => competitionsSeen.add(c))
  const cat = event.categoryIds[0]
  const capEmail = runnerEmail('captain')
  const memberEmail = runnerEmail('member')
  const team = await teamOk(event, {
    members: [captain(capEmail), adult(cat, 'adult', memberEmail)],
  })
  assert.ok(team)
  const regs = await rows('registrations', { event_id: event.eventId })
  const cap = regs.find((r) => r.email === capEmail)
  const mem = regs.find((r) => r.email === memberEmail)
  const capSession = await sessionFor(capEmail)
  const memSession = await sessionFor(memberEmail)

  assert.equal((await edit(capSession, cap.id, { city: 'Szubin' })).status, 200)
  assert.equal((await targets(capSession, cap.id)).status, 404)
  assert.equal((await change(capSession, cap.id, cat, 0)).status, 404)
  assert.equal((await targets(memSession, mem.id)).status, 404)
  assert.equal((await edit(memSession, mem.id, { city: 'Szubin' })).status, 404)
})

// ---------------------------------------------------------------- RS-14 throttle

test('RS-14 ten changes and edits per entry per 24 h; the 11th is 429', async () => {
  const event = await paidEvent()
  const e = await ownEntry(event)
  for (let i = 0; i < 10; i++) {
    const r = await edit(e.session, e.registrationId, { city: `Miasto ${i}` })
    assert.equal(r.status, 200, `edit ${i}: ${JSON.stringify(r.body)}`)
  }
  const over = await edit(e.session, e.registrationId, { city: 'Jedenaste' })
  assert.equal(over.status, 429)
  assert.ok(over.body.error)
  const overChange = await change(e.session, e.registrationId, event.categoryIds[1], -2000)
  assert.equal(overChange.status, 429)
  assert.equal((await reg(e.registrationId)).category_id, event.categoryIds[0])
  assert.equal((await changesOf(e.registrationId)).length, 10)
})

test('RS-14 a retried change with the same request key spends no allowance and returns the first outcome', async () => {
  const event = await paidEvent()
  const e = await ownEntry(event)
  for (let i = 0; i < 9; i++) {
    const r = await edit(e.session, e.registrationId, { city: `Miasto ${i}` })
    assert.equal(r.status, 200, `edit ${i}: ${JSON.stringify(r.body)}`)
  }
  const requestKey = key()
  const tenth = await change(e.session, e.registrationId, event.categoryIds[2], 2000, { requestKey })
  assert.equal(tenth.status, 200, JSON.stringify(tenth.body))
  const retry = await change(e.session, e.registrationId, event.categoryIds[2], 2000, { requestKey })
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  assert.deepEqual([retry.body.data.outcome, retry.body.data.orderId], ['surcharge', tenth.body.data.orderId])
  assert.equal((await changesOf(e.registrationId)).length, 10, 'the replay writes no audit row')
  const over = await edit(e.session, e.registrationId, { city: 'Jedenaste' })
  assert.equal(over.status, 429)
})

// ---------------------------------------------------------------- RS-16 details, list actions

test('RS-16 details prefills „Popraw dane” (never the e-mail); my-registrations and my-event-registrations carry actions', async () => {
  const event = await paidEvent()
  const e = await ownEntry(event)
  const d = await act(e.session, { action: 'details', registrationId: e.registrationId })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  const stored = await reg(e.registrationId)
  assert.deepEqual(d.body.data.person, {
    firstName: stored.first_name, lastName: stored.last_name, birthDate: stored.birth_date, gender: stored.gender,
    phone: stored.phone, city: stored.city, club: stored.club, nationality: stored.nationality,
    iceName: stored.ice_name, icePhone: stored.ice_phone,
  })
  assert.ok(!JSON.stringify(d.body).includes(e.email), 'no e-mail in the prefill')
  assert.deepEqual([d.body.data.competitionChange, d.body.data.dataEdit, d.body.data.status], [true, true, 'confirmed'])
  assert.equal(typeof d.body.data.formFields, 'object')

  const { slug } = await one('registration_settings', { event_id: event.eventId })
  const listed = async () => {
    const mine = await callFn('my-registrations', e.session, {})
    const ev = mine.body.data.find((x) => x.eventId === event.eventId)
    const onEvent = await callFn('my-event-registrations', e.session, { slug })
    return [ev.people.find((p) => p.id === e.registrationId).actions, onEvent.body.data.find((r) => r.id === e.registrationId).actions]
  }
  assert.deepEqual(await listed(), [{ change: true, edit: true }, { change: true, edit: true }])
  await setSettings(event.eventId, { runner_competition_change: false })
  assert.deepEqual(await listed(), [{ change: false, edit: true }, { change: false, edit: true }])
  await setSettings(event.eventId, { runner_data_edit: false })
  assert.deepEqual(await listed(), [{ change: false, edit: false }, { change: false, edit: false }])
  const { error: offErr } = await db().from('clubs').update({ registration_enabled: false }).eq('slug', 'zatyrani-test')
  if (offErr) throw offErr
  try {
    await setSettings(event.eventId, { runner_competition_change: true, runner_data_edit: true })
    const mine = await callFn('my-registrations', e.session, {})
    const ev = mine.body.data.find((x) => x.eventId === event.eventId)
    assert.deepEqual(ev.people.find((p) => p.id === e.registrationId).actions, { change: false, edit: false }, 'club disabled')
    const onEvent = await callFn('my-event-registrations', e.session, { slug })
    assert.deepEqual(onEvent.body.data.find((r) => r.id === e.registrationId).actions, { change: false, edit: false }, 'club disabled')
  } finally {
    const { error: back } = await db().from('clubs').update({ registration_enabled: true }).eq('slug', 'zatyrani-test')
    if (back) throw back
  }
  assert.deepEqual(await listed(), [{ change: true, edit: true }, { change: true, edit: true }])
  await setSettings(event.eventId, { runner_competition_change: true, runner_data_edit: true, closes_at: new Date(Date.now() - 60_000).toISOString() })
  assert.deepEqual(await listed(), [{ change: false, edit: false }, { change: false, edit: false }], 'after closes_at')
})

test('RS-16c an event with one visible individual competition: no „Zmień konkurencję” (lists, targets, details); a hidden second one does not count; „Popraw dane” stays', async () => {
  const event = await createPublishedPaidEvent(owner, { competitions: [BIEG(), C5], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000 } })
  event.categoryIds.forEach((c) => competitionsSeen.add(c))
  const e = await ownEntry(event)
  const { slug } = await one('registration_settings', { event_id: event.eventId })
  const listed = async () => {
    const mine = await callFn('my-registrations', e.session, {})
    const ev = mine.body.data.find((x) => x.eventId === event.eventId)
    const onEvent = await callFn('my-event-registrations', e.session, { slug })
    return [ev.people.find((p) => p.id === e.registrationId).actions, onEvent.body.data.find((r) => r.id === e.registrationId).actions]
  }
  assert.deepEqual(await listed(), [{ change: true, edit: true }, { change: true, edit: true }], 'two visible individual competitions')
  const { error } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', event.categoryIds[1])
  if (error) throw error
  assert.deepEqual(await listed(), [{ change: false, edit: true }, { change: false, edit: true }], 'the other one hidden: nowhere to go')
  const t = await targets(e.session, e.registrationId)
  assert.deepEqual([t.status, t.body.data.allowed, t.body.data.competitionChange], [200, false, false])
  const d = await act(e.session, { action: 'details', registrationId: e.registrationId })
  assert.deepEqual([d.body.data.competitionChange, d.body.data.dataEdit], [false, true])
  assert.equal((await edit(e.session, e.registrationId, { city: 'Szubin' })).status, 200)
})

test('RS-16b a club with no organizer agreement at all: no „Zmień konkurencję” anywhere and change 403 not_allowed; „Popraw dane” stays (L-2); an older version only is enough (§13 ust. 6)', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const e = await ownEntry(event)
  const { slug } = await one('registration_settings', { event_id: event.eventId })
  const listed = async () => {
    const mine = await callFn('my-registrations', e.session, {})
    const ev = mine.body.data.find((x) => x.eventId === event.eventId)
    const onEvent = await callFn('my-event-registrations', e.session, { slug })
    return [ev.people.find((p) => p.id === e.registrationId).actions, onEvent.body.data.find((r) => r.id === e.registrationId).actions]
  }
  assert.deepEqual(await listed(), [{ change: true, edit: true }, { change: true, edit: true }], 'current version accepted')
  const { data: club } = await db().from('clubs').select('id, name').eq('slug', 'zatyrani-test').single()
  const { data: kept } = await db().from('organizer_agreements').select('*').eq('club_id', club.id)
  const { error: delErr } = await db().from('organizer_agreements').delete().eq('club_id', club.id)
  if (delErr) throw delErr
  try {
    assert.deepEqual(await listed(), [{ change: false, edit: true }, { change: false, edit: true }])
    const t = await targets(e.session, e.registrationId)
    assert.equal(t.status, 200)
    assert.deepEqual([t.body.data.allowed, t.body.data.competitionChange, t.body.data.refusal, t.body.data.targets], [false, false, 'not_allowed', []])
    const d = await act(e.session, { action: 'details', registrationId: e.registrationId })
    assert.deepEqual([d.body.data.competitionChange, d.body.data.dataEdit], [false, true])
    const refusedChange = await change(e.session, e.registrationId, c5, -2000)
    assert.deepEqual([refusedChange.status, refusedChange.body.code], [403, 'not_allowed'])
    assert.equal((await reg(e.registrationId)).category_id, event.categoryIds[0])
    const edited = await edit(e.session, e.registrationId, { city: 'Szubin' })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    // The organizer's change is untouched.
    const byOrganizer = await callFn('organizer-entry-action', owner, {
      action: 'change_competition', registrationId: e.registrationId, categoryId: c5, expectedDifference: -2000, requestKey: crypto.randomUUID(),
    })
    assert.equal(byOrganizer.status, 200, JSON.stringify(byOrganizer.body))
    // Only an older version: the agreement was updated, never re-accepted; the change is offered.
    const { error: oldErr } = await db().from('organizer_agreements').insert({ club_id: club.id, club_name: club.name, version: '2026-11-v1' })
    if (oldErr) throw oldErr
    const again = await ownEntry(event)
    const mine = await callFn('my-registrations', again.session, {})
    const person = mine.body.data.find((x) => x.eventId === event.eventId).people.find((p) => p.id === again.registrationId)
    assert.equal(person.actions.change, true)
  } finally {
    await db().from('organizer_agreements').delete().eq('club_id', club.id)
    if (kept.length) await db().from('organizer_agreements').insert(kept)
    await acceptAgreement('zatyrani-test')
  }
  assert.deepEqual(await listed(), [{ change: true, edit: true }, { change: true, edit: true }])
})

