// Plan 7 final review I-1 + I-4 (coordinator ruling): while PAID_REGISTRATION_ENABLED is false (the
// production default), every money feature of Plan 7 is OFF: donations, extras (priced and 0 zł),
// vouchers and the organizer's codes and partners. A published free charity event with
// donations_enabled behaves exactly as on main.
//
// The local stack runs with Plan 7's money features on (REGISTRATION_MONEY_TEST=on in functions.env,
// honoured only on an http:// local SUPABASE_URL), so the rest of the suite can exercise them. These
// tests send `x-registration-money: off`, which turns them off for one request, the way production
// always is. Transfers stay live: no money moves. Scenario V-90 in docs/registration/scenario-matrix.md.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGE_PROXY, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { consentIds, db, one, person, runnerEmail } from './helpers/orders.js'
import { makeExtra, makeVoucher, setCharity } from './helpers/cart.js'
import { enableTransfers, freeEntry } from './helpers/transfers.js'
import { mergePending } from '../../public/src/lib/eventPageModel.js'

let owner
before(async () => {
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

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

/** A published FREE charity event with donations on and a 45 zł shirt, as production may hold today. */
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

test('V-90 flag off: a free charity event registers free exactly as on main; a donation, an extra or a code is refused 409 payments, by register-free and create-order', async () => {
  const event = await charityFree()
  const email = runnerEmail('off')
  const session = await sessionFor(email)

  for (const extra of [{}, { extras: [{ variantId: event.shirt.variants.M.id, qty: 1 }] }, { voucherCode: 'LESZY-ABC123' }]) {
    const r = await call('create-order', { ...(await body(event, email, extra)), displayedTotal: 4500, ...(Object.keys(extra).length ? {} : { donation: 2000 }) }, session)
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.code, 'payments', r.text)
  }
  const withDonation = await call('register-free', { ...(await body(event, email)), donation: 2000 }, session)
  assert.equal(withDonation.status, 409, withDonation.text)
  assert.equal(withDonation.body.code, 'payments')
  const withExtra = await call('register-free', await body(event, email, { extras: [{ variantId: event.shirt.variants.M.id, qty: 1 }] }), session)
  assert.equal(withExtra.status, 409, withExtra.text)

  // Main's path: nothing but the entry, free.
  const plain = await call('register-free', await body(event, email), session)
  assert.equal(plain.status, 201, plain.text)
  assert.equal((await db().from('orders').select('id').eq('event_id', event.eventId)).data.length, 0, 'no order exists')
  assert.equal((await one('extra_variants', { id: event.shirt.variants.M.id })).sold, 0)
})

test('V-90 flag off: check-voucher and organizer-vouchers answer 409 payments; nothing is written', async () => {
  const event = await charityFree()
  const v = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const checked = await call('check-voucher', { slug: event.slug, categoryId: event.categoryIds[0], code: v.code })
  assert.equal(checked.status, 409, checked.text)
  assert.equal(checked.body.code, 'payments')
  const created = await call('organizer-vouchers', { eventId: event.eventId, action: 'partner_create', name: 'Sklep' }, owner)
  assert.equal(created.status, 409, created.text)
  assert.equal(created.body.code, 'payments')
  assert.equal((await db().from('registration_partners').select('id').eq('event_id', event.eventId)).data.length, 0)
})

test('V-90 flag off: „Opublikuj zmiany” on a free charity event with donations and a priced extra is not blocked; get-registration-event says moneyLive false with no payments item', async () => {
  const event = await charityFree()
  const saved = await call('save-registration-section', { eventId: event.eventId, section: 'basics', value: { firstStartTime: '10:15' } }, owner)
  assert.equal(saved.status, 200, saved.text)
  const pub = await call('publish-registration-event', { eventId: event.eventId, action: 'publish_changes', notify: { send: false } }, owner)
  assert.equal(pub.status, 200, pub.text)
  const read = await call('get-registration-event', { eventId: event.eventId }, owner)
  assert.equal(read.status, 200, read.text)
  assert.equal(read.body.data.moneyLive, false)
  assert.ok(!read.body.data.checklist.blocking.some((b) => b.key === 'payments' || b.key === 'payout'), JSON.stringify(read.body.data.checklist))

  // The same event on the money-live test stack is held, as before (the flag-on behaviour stays).
  const held = await call('publish-registration-event', { eventId: event.eventId, action: 'publish_changes', notify: { send: false } }, owner, { money: 'on' })
  assert.notEqual(held.status, 200)
})

test('V-90 flag off: transfers stay live for free entries (runner invite and organizer transfer)', async () => {
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
// sees. With the money features off, /api/event serves no donations and no extras, so the
// preview must not show them either: not from the live event, not from staged changes.
test('V-97 flag off: preview-registration-event hides donations and extras, live and staged, exactly as /api/event does', async () => {
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

  const off = await call('preview-registration-event', { eventId: event.eventId, withPending: true }, owner)
  assert.equal(off.status, 200, off.text)
  const { raw, pending } = off.body.data
  assert.equal(raw.donationsEnabled, false)
  assert.deepEqual(raw.extras, [])
  assert.ok(!off.text.includes('Koszulka') && !off.text.includes('Czapka'), off.text)
  const shown = mergePending(raw, pending)
  assert.equal(shown.donationsEnabled, false, 'a staged donations switch does not bring the chips back')
  assert.deepEqual(shown.extras, [], 'staged extras do not come back')
  assert.equal(shown.firstStartTime, '10:15', 'the other staged changes still show')
  assert.equal(raw.isCharity, true, 'the charity itself is not money')

  // Without the staged changes, the same.
  const plain = await call('preview-registration-event', { eventId: event.eventId }, owner)
  assert.equal(plain.body.data.raw.donationsEnabled, false)
  assert.deepEqual(plain.body.data.raw.extras, [])

  // On the money-live test stack the preview still shows both (the flag-on behaviour).
  const on = await call('preview-registration-event', { eventId: event.eventId, withPending: true }, owner, { money: 'on' })
  assert.equal(on.status, 200, on.text)
  assert.equal(on.body.data.raw.donationsEnabled, true)
  assert.deepEqual(on.body.data.raw.extras.map((x) => x.name), ['Koszulka'])
  assert.deepEqual(mergePending(on.body.data.raw, on.body.data.pending).extras.map((x) => x.name), ['Czapka'])
})
