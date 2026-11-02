// Plan 7 final review I-1 + I-4, with PAID_REGISTRATION_ENABLED true (production since the flag
// flip): every money feature of Plan 7 is LIVE: donations, extras (priced and 0 zł), vouchers and the
// organizer's codes and partners, and a paid event publishes. The local test switch
// (REGISTRATION_MONEY_TEST) and the `x-registration-money: off` header are only consulted while the
// flag is false, so every request here carries the off header and must still find the features live.
// Transfers stay live, as they always were. Scenarios V-90 and V-97 in docs/registration/scenario-matrix.md.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGE_PROXY, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { startDpayMock } from './helpers/dpayControl.js'
import { consentIds, db, one, orderOf, person, runnerEmail } from './helpers/orders.js'
import { makeExtra, makeVoucher, setCharity } from './helpers/cart.js'
import { enableTransfers, freeEntry } from './helpers/transfers.js'
import { mergePending } from '../../public/src/lib/eventPageModel.js'

let owner, stopMock
before(async () => {
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (stopMock) await stopMock() })

const OFF = { 'x-registration-money': 'off' }
let n = 0
async function call(fn, body, session, { money = 'off' } = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': `198.51.100.${(n++ % 250) + 1}`,
      ...(money === 'off' ? OFF : {}), ...(session ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, text }
}

/** A published FREE charity event with donations on and a 45 zł shirt. */
async function charityFree() {
  const event = await createPublishedFreeEvent(owner)
  await setCharity(event.eventId, true)
  const shirt = await makeExtra(event, { name: 'Koszulka', price: 4500, variants: [['M', 10]] })
  return { ...event, shirt }
}

const body = async (event, email, over = {}) => ({
  people: [{ categoryId: event.categoryIds[0], person: person(email), ...over }],
  acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
})

test('V-90 flag on: the off header is ignored; on a free charity event a donation or a shirt is an order, a code is checked, register-free keeps the free path', async () => {
  const event = await charityFree()
  const order = async (tag, extra, over) => {
    const email = runnerEmail(tag)
    return call('create-order', { ...(await body(event, email, extra)), ...over }, await sessionFor(email))
  }

  const gift = await order('gift', {}, { donation: 2000, displayedTotal: 2000 })
  assert.equal(gift.status, 201, gift.text)
  const giftOrder = await orderOf(gift.body.data.orderId)
  assert.deepEqual([giftOrder.entry_total, giftOrder.donation, giftOrder.total], [0, 2000, 2000])

  const shirt = await order('shirt', { extras: [{ variantId: event.shirt.variants.M.id, qty: 1 }] }, { displayedTotal: 4500 })
  assert.equal(shirt.status, 201, shirt.text)
  assert.equal((await orderOf(shirt.body.data.orderId)).extras_total, 4500)
  assert.equal((await one('extra_variants', { id: event.shirt.variants.M.id })).sold, 1)

  const coded = await order('code', { voucherCode: 'LESZY-ABC123' }, { displayedTotal: 0 })
  assert.equal(coded.status, 409, coded.text)
  assert.notEqual(coded.body.code, 'payments', coded.text)

  // register-free still takes no money: a donation is the cart sentence, a plain entry registers free.
  const email = runnerEmail('free')
  const session = await sessionFor(email)
  const withDonation = await call('register-free', { ...(await body(event, email)), donation: 2000 }, session)
  assert.deepEqual([withDonation.status, withDonation.body.code], [409, 'not_free'], withDonation.text)
  const plain = await call('register-free', await body(event, email), session)
  assert.equal(plain.status, 201, plain.text)
})

test('V-90 flag on: check-voucher answers the price and organizer-vouchers writes, with the off header', async () => {
  const event = await createPublishedPaidEvent(owner)
  const v = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const checked = await call('check-voucher', { slug: event.slug, categoryId: event.categoryIds[0], code: v.code })
  assert.equal(checked.status, 200, checked.text)
  assert.deepEqual(checked.body, { data: { percent: 15, price: 5100 } })
  const created = await call('organizer-vouchers', { eventId: event.eventId, action: 'partner_create', name: 'Sklep' }, owner)
  assert.equal(created.status, 201, created.text)
  assert.equal((await db().from('registration_partners').select('id').eq('event_id', event.eventId)).data.length, 1)
})

test('V-90 flag on: „Opublikuj zmiany” on a charity event with donations and a priced extra needs only a payout account; get-registration-event says moneyLive true with no payments item', async () => {
  const event = await charityFree()
  const payout = await call('update-event-payout', {
    eventId: event.eventId, mode: 'custom', recipient: 'Fundacja Leśna Pomoc', taxId: '526-025-02-74',
    iban: 'PL61 1090 1014 0000 0712 1981 2874', title: 'Bieg Leszego — wpisowe',
  }, owner)
  assert.equal(payout.status, 200, payout.text)
  const read = await call('get-registration-event', { eventId: event.eventId }, owner)
  assert.equal(read.status, 200, read.text)
  assert.equal(read.body.data.moneyLive, true)
  assert.deepEqual(read.body.data.checklist.blocking, [], JSON.stringify(read.body.data.checklist))

  const saved = await call('save-registration-section', { eventId: event.eventId, section: 'basics', value: { firstStartTime: '10:15' } }, owner)
  assert.equal(saved.status, 200, saved.text)
  const pub = await call('publish-registration-event', { eventId: event.eventId, action: 'publish_changes', notify: { send: false } }, owner)
  assert.equal(pub.status, 200, pub.text)
})

test('V-90 flag on: transfers stay live for free entries (runner invite and organizer transfer)', async () => {
  const event = await createPublishedFreeEvent(owner)
  await enableTransfers(event)
  const a = await freeEntry(event)
  const holder = await sessionFor(a.email)
  const invite = await call('transfer-invite', { action: 'create', registrationId: a.reg.id, toEmail: runnerEmail('in') }, holder)
  assert.equal(invite.status, 201, invite.text)
  const b = await freeEntry(event)
  const org = await call('organizer-entry-action', {
    action: 'transfer', registrationId: b.reg.id, categoryId: event.categoryIds[0],
    person: { firstName: 'Jan', lastName: 'Nowak', birthDate: '1985-05-05', gender: 'M', email: runnerEmail('org'), phone: '600700800' },
  }, owner)
  assert.equal(org.status, 200, org.text)
})

// Plan 7 follow-up NB-3 (V-97): „Podgląd jako zawodnik” shows the organizer the page a runner
// sees. With the money features live, /api/event serves donations and extras, so the preview shows
// them too, live and staged, whatever the off header says.
test('V-97 flag on: preview-registration-event shows donations and extras, live and staged, exactly as /api/event does', async () => {
  const event = await charityFree()
  const { error } = await db().from('registration_pending_changes').insert({
    event_id: event.eventId,
    payload: {
      basics: { donations_enabled: true, first_start_time: '10:15' },
      extras: { items: [{ id: null, name: 'Czapka', price: 2000, order_until: event.eventDate, category_ids: [], variants: [{ id: null, label: 'S', stock: 5 }] }] },
    },
    changed_fields: ['basics', 'extras'],
  })
  assert.ifError(error)

  for (const money of ['off', 'on']) {
    const r = await call('preview-registration-event', { eventId: event.eventId, withPending: true }, owner, { money })
    assert.equal(r.status, 200, r.text)
    const { raw, pending } = r.body.data
    assert.equal(raw.donationsEnabled, true, money)
    assert.deepEqual(raw.extras.map((x) => x.name), ['Koszulka'], money)
    const shown = mergePending(raw, pending)
    assert.equal(shown.donationsEnabled, true, money)
    assert.deepEqual(shown.extras.map((x) => x.name), ['Czapka'], money)
    assert.equal(shown.firstStartTime, '10:15', money)
    assert.equal(raw.isCharity, true, money)
  }

  // Without the staged changes, the same live event.
  const plain = await call('preview-registration-event', { eventId: event.eventId }, owner)
  assert.equal(plain.body.data.raw.donationsEnabled, true)
  assert.deepEqual(plain.body.data.raw.extras.map((x) => x.name), ['Koszulka'])
})
