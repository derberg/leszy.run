// W-88: a confirmed entry stars the event for the people on it (trigger registration_auto_follow,
// migration 20261110100000), and „Moje zapisy” (my-registrations) lists the session's orders and
// entries. LOCAL stack only; every event and address is random, so reruns pass.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor, EDGE_PROXY } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { attemptFor, confirmOk, db, orderOk, profileFor, runnerEmail } from './helpers/orders.js'

let owner, stopCapture
before(async () => {
  stopCapture = await startCapture()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (stopCapture) await stopCapture() })
beforeEach(async () => { await resetThrottle() })

const calendarId = async (eventId) => (await db().from('calendar_events').select('id')
  .eq('source', 'leszyrun').eq('source_id', eventId).maybeSingle()).data?.id ?? null
const starred = async (profileId, calId) => (await db().from('event_favorites').select('user_id')
  .eq('user_id', profileId).eq('event_id', calId)).data.length === 1

async function registerFree(event, email, session) {
  const { data: consents } = await db().from('event_consents').select('id').eq('event_id', event.eventId)
  const res = await fetch(`${localEnv().functionsUrl}/register-free`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, cookie: session.cookie },
    body: JSON.stringify({
      categoryId: event.categoryIds[0],
      person: { firstName: 'Ola', lastName: 'Obserwująca', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
      acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true,
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 201, JSON.stringify(body))
  return body
}

test('W-88 a free entry stars the event once; an unstar sticks through later updates; an unlisted event stars nothing', async () => {
  const event = await createPublishedFreeEvent(owner)
  const cal = await calendarId(event.eventId)
  assert.ok(cal, 'a listed event has its calendar row')
  const email = runnerEmail('follow')
  const session = await sessionFor(email)
  await registerFree(event, email, session)
  assert.equal(await starred(session.profileId, cal), true, 'confirmed → starred')

  await db().from('event_favorites').delete().eq('user_id', session.profileId).eq('event_id', cal)
  const { data: [r] } = await db().from('registrations').select('id').eq('event_id', event.eventId).eq('profile_id', session.profileId)
  const { error } = await db().from('registrations').update({ status: 'confirmed' }).eq('id', r.id)
  assert.equal(error, null)
  assert.equal(await starred(session.profileId, cal), false, 'confirmed → confirmed is no transition: the unstar stays')

  const hidden = await createPublishedFreeEvent(owner, { listed: false })
  assert.equal(await calendarId(hidden.eventId), null)
  const email2 = runnerEmail('hidden')
  const s2 = await sessionFor(email2)
  await registerFree(hidden, email2, s2)
  const { data: favs } = await db().from('event_favorites').select('event_id').eq('user_id', s2.profileId)
  assert.deepEqual(favs, [], 'no calendar row, nothing to star')
})

test('W-88 a paid order stars the event only when it is paid, for the buyer; my-registrations lists it', async () => {
  const event = await createPublishedPaidEvent(owner)
  const cal = await calendarId(event.eventId)
  const email = runnerEmail('paid')
  const out = await orderOk(event, { emails: [email] })
  const buyer = await profileFor(email)
  assert.equal(await starred(buyer, cal), false, 'awaiting payment: not yet')

  const session = await sessionFor(email)
  let res = await callFn('my-registrations', session, {})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  let mine = res.body.data.find((e) => e.eventId === event.eventId)
  assert.ok(mine, JSON.stringify(res.body))
  assert.equal(mine.slug, event.slug)
  assert.equal(mine.eventDate, event.eventDate)
  assert.deepEqual(mine.orders.map((o) => [o.id, o.status, o.total]), [[out.orderId, 'pending', out.total]])
  assert.deepEqual(mine.people.map((p) => [p.status, p.competition, p.mine]), [['pending_payment', 'Bieg 9 km', true]])

  const att = await attemptFor(out.orderId, out.total)
  await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(await starred(buyer, cal), true, 'paid → starred')

  res = await callFn('my-registrations', session, {})
  mine = res.body.data.find((e) => e.eventId === event.eventId)
  assert.equal(mine.orders[0].status, 'paid')
  assert.equal(mine.people[0].status, 'confirmed')
})

test('W-88 my-registrations: 401 without a session; a stranger sees none of it; the runner sees exactly their event', async () => {
  assert.equal((await callFn('my-registrations', null, {})).status, 401)
  const event = await createPublishedFreeEvent(owner)
  const email = runnerEmail('own')
  const session = await sessionFor(email)
  await registerFree(event, email, session)
  const stranger = await sessionFor(`stranger-${crypto.randomBytes(4).toString('hex')}@test.local`)
  const res = await callFn('my-registrations', stranger, {})
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data, [])

  const listed = (await callFn('my-registrations', session, {})).body.data.map((e) => e.eventId)
  assert.deepEqual(listed, [event.eventId])
})
