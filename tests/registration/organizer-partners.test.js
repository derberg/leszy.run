// Event partners, task 2: `organizer-partners`, the wizard's partner CRUD on the one
// `event_partners` table, outside the money switch. Scenarios EP-7…EP-11 in
// docs/registration/scenario-matrix.md. LOCAL stack only.
import { test, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EDGE_PROXY, admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { db, one, rows, runnerEmail } from './helpers/orders.js'
import { makeVoucher, vouchersMade } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'

const NAME = 'Nazwa partnera: 1–80 znaków.'
const NOTE = 'Notatka: do 500 znaków.'
const URL_MSG = 'Podaj adres zaczynający się od http:// lub https://.'
const TAKEN = 'Taki partner już istnieje.'
const REFERENCED = 'Partnera przypisanego do kodów lub zgłoszeń nie można usunąć.'

let owner, adminS, member, outsider, innyAdmin, clubId
before(async () => {
  await resetThrottle()
  clubId = await acceptAgreement('zatyrani-test')
  ;[owner, adminS, member, outsider, innyAdmin] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local',
    runnerEmail('outsider'), 'admin@inny-klub.local',
  ].map(sessionFor))
})
afterEach(async () => {
  const ids = [...vouchersMade]
  vouchersMade.clear()
  for (const id of ids) await assertVoucherInvariant(id)
})

const rand = () => crypto.randomBytes(4).toString('hex')
const paidEvent = () => createPublishedPaidEvent(owner)
const partners = (eventId, body, session = owner) => callFn('organizer-partners', session, { eventId, ...body })
const actions = (eventId) => rows('organizer_actions', { event_id: eventId })

async function create(eventId, over = {}) {
  const r = await partners(eventId, { action: 'create', name: `Sklep ${rand()}`, ...over })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return one('event_partners', { id: r.body.data.id })
}

const bucket = () => admin().storage.from('partner-logos')
async function uploadLogo() {
  const path = `${crypto.randomUUID()}.png`
  const { error } = await bucket().upload(path, Buffer.from('89504e470d0a1a0a', 'hex'), { contentType: 'image/png' })
  assert.equal(error, null, error?.message)
  return path
}
async function logoExists(path) {
  const { data, error } = await bucket().download(path)
  return !error && data != null
}

// ---------------------------------------------------------------- EP-7

test('EP-7 organizer-partners: create, list, update, reorder and delete, each logged with field names only', async () => {
  const event = await paidEvent()
  const empty = await partners(event.eventId, { action: 'list' })
  assert.equal(empty.status, 200, JSON.stringify(empty.body))
  assert.deepEqual(empty.body, { data: { partners: [] } })

  const r = await partners(event.eventId, {
    action: 'create', name: '  Sklep Biegacz ', note: ' umowa do 2027 ', websiteUrl: 'https://sklep.pl', isPublic: false,
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(Object.keys(r.body.data), ['id'])
  const a = await one('event_partners', { id: r.body.data.id })
  assert.deepEqual([a.name, a.note, a.website_url, a.is_public, a.sort_order, a.event_id],
    ['Sklep Biegacz', 'umowa do 2027', 'https://sklep.pl', false, 0, event.eventId])
  const b = await create(event.eventId, { name: 'Radio Piekary' })
  assert.deepEqual([b.is_public, b.sort_order, b.note, b.website_url], [true, 1, null, null], 'public by default, last in order')
  const c = await create(event.eventId, { name: 'Piekarnia' })
  assert.equal(c.sort_order, 2)

  const list = await partners(event.eventId, { action: 'list' })
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.deepEqual(list.body.data.partners, [
    { id: a.id, name: 'Sklep Biegacz', note: 'umowa do 2027', websiteUrl: 'https://sklep.pl', logoUrl: null, isPublic: false, sortOrder: 0, referenced: false },
    { id: b.id, name: 'Radio Piekary', note: null, websiteUrl: null, logoUrl: null, isPublic: true, sortOrder: 1, referenced: false },
    { id: c.id, name: 'Piekarnia', note: null, websiteUrl: null, logoUrl: null, isPublic: true, sortOrder: 2, referenced: false },
  ])

  const up = await partners(event.eventId, { action: 'update', id: a.id, name: 'Sklep Biegacz 2', note: null, websiteUrl: '', isPublic: true })
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.deepEqual(up.body, { data: { id: a.id } })
  const a2 = await one('event_partners', { id: a.id })
  assert.deepEqual([a2.name, a2.note, a2.website_url, a2.is_public], ['Sklep Biegacz 2', null, null, true])
  assert.ok(a2.updated_at, 'updated_at stamped')
  // Only what was sent changes.
  assert.equal((await partners(event.eventId, { action: 'update', id: b.id, note: 'barter' })).status, 200)
  const b2 = await one('event_partners', { id: b.id })
  assert.deepEqual([b2.name, b2.note, b2.is_public], ['Radio Piekary', 'barter', true])

  const re = await partners(event.eventId, { action: 'reorder', ids: [c.id, a.id, b.id] })
  assert.equal(re.status, 200, JSON.stringify(re.body))
  const ordered = (await partners(event.eventId, { action: 'list' })).body.data.partners
  assert.deepEqual(ordered.map((p) => [p.id, p.sortOrder]), [[c.id, 0], [a.id, 1], [b.id, 2]])

  const del = await partners(event.eventId, { action: 'delete', id: c.id })
  assert.equal(del.status, 200, JSON.stringify(del.body))
  assert.deepEqual(del.body, { data: { deleted: true } })
  assert.deepEqual(await rows('event_partners', { id: c.id }), [])
  const next = await create(event.eventId)
  assert.equal(next.sort_order, 3, 'a new partner goes after the highest sort_order')

  const logged = await actions(event.eventId)
  const byAction = (name) => logged.filter((l) => l.action === name)
  assert.equal(byAction('partner_created').length, 4)
  assert.deepEqual(byAction('partner_created').find((l) => l.target === a.id).payload,
    { fields: ['name', 'note', 'websiteUrl', 'isPublic'] })
  assert.deepEqual(Object.fromEntries(byAction('partner_updated').map((l) => [l.target, l.payload])),
    { [a.id]: { fields: ['name', 'note', 'websiteUrl', 'isPublic'] }, [b.id]: { fields: ['note'] } })
  assert.deepEqual(byAction('partner_reordered').map((l) => l.target), [event.eventId])
  assert.deepEqual(byAction('partner_deleted').map((l) => l.target), [c.id])
  for (const l of logged.filter((x) => x.action.startsWith('partner_'))) {
    assert.ok(l.payload == null || Object.keys(l.payload).join() === 'fields', `${l.action}: ${JSON.stringify(l.payload)}`)
    assert.ok(!/Sklep|Radio|Piekar|umowa|barter|sklep\.pl/.test(JSON.stringify(l.payload)), `${l.action} holds a value`)
  }
})

// ---------------------------------------------------------------- EP-8

test('EP-8 refusals: 422 fields with the three messages, 409 partner_taken in any case, a bad reorder 422, an unknown action 400', async () => {
  const event = await paidEvent()
  const bad = await partners(event.eventId, { action: 'create', name: ' ', note: 'n'.repeat(501), websiteUrl: 'javascript:alert(1)' })
  assert.equal(bad.status, 422, JSON.stringify(bad.body))
  assert.deepEqual(bad.body.fields, { name: NAME, note: NOTE, websiteUrl: URL_MSG })
  for (const [field, value] of [['name', 'x'.repeat(81)], ['websiteUrl', 'ftp://sklep.pl'], ['websiteUrl', `https://${'a'.repeat(493)}.pl`]]) {
    const r = await partners(event.eventId, { action: 'create', name: 'Sklep', [field]: value })
    assert.deepEqual([r.status, Object.keys(r.body.fields ?? {})], [422, [field]], `${field} ${value.length}`)
  }
  const notBool = await partners(event.eventId, { action: 'create', name: 'Sklep', isPublic: 'tak' })
  assert.deepEqual([notBool.status, Object.keys(notBool.body.fields ?? {})], [422, ['isPublic']])
  assert.deepEqual(await rows('event_partners', { event_id: event.eventId }), [], 'no refused write landed')

  const a = await create(event.eventId, { name: 'Sklep Biegacz' })
  const b = await create(event.eventId, { name: 'Radio' })
  const dup = await partners(event.eventId, { action: 'create', name: 'SKLEP BIEGACZ' })
  assert.deepEqual([dup.status, dup.body.code, dup.body.error], [409, 'partner_taken', TAKEN])
  const ren = await partners(event.eventId, { action: 'update', id: b.id, name: 'sklep biegacz' })
  assert.deepEqual([ren.status, ren.body.code], [409, 'partner_taken'])
  const blank = await partners(event.eventId, { action: 'update', id: b.id, name: '' })
  assert.deepEqual([blank.status, blank.body.fields], [422, { name: NAME }])
  assert.equal((await one('event_partners', { id: b.id })).name, 'Radio')

  for (const ids of [[a.id], [a.id, b.id, b.id], [a.id, b.id, crypto.randomUUID()], [a.id, 'x'], 'x', null]) {
    const r = await partners(event.eventId, { action: 'reorder', ids })
    assert.equal(r.status, 422, `${JSON.stringify(ids)}: ${JSON.stringify(r.body)}`)
  }
  assert.deepEqual((await rows('event_partners', { event_id: event.eventId })).map((p) => p.sort_order).sort(), [0, 1])

  const unknown = await partners(event.eventId, { action: 'drop_table' })
  assert.deepEqual([unknown.status, unknown.body.code], [400, 'invalid_action'])
  assert.equal((await partners(event.eventId, { action: 'list' }, null)).status, 401)
})

// ---------------------------------------------------------------- EP-9

test('EP-9 who may: a member, an outsider, another club\'s admin and a disabled club get 404; the admin may write; another event\'s partner id 404', async () => {
  const event = await paidEvent()
  const mine = await create(event.eventId)
  for (const [who, session] of [['member', member], ['outsider', outsider], ['innyAdmin', innyAdmin]]) {
    for (const body of [{ action: 'list' }, { action: 'create', name: `Sklep ${rand()}` }, { action: 'delete', id: mine.id }]) {
      const r = await partners(event.eventId, body, session)
      assert.equal(r.status, 404, `${who} ${body.action}: ${JSON.stringify(r.body)}`)
    }
  }
  assert.equal((await rows('event_partners', { event_id: event.eventId })).length, 1, 'no refused write landed')
  assert.equal((await partners(event.eventId, { action: 'create', name: `Sklep ${rand()}` }, adminS)).status, 201)
  assert.equal((await partners(event.eventId, { action: 'list' }, adminS)).status, 200)

  const other = await paidEvent()
  const foreign = await create(other.eventId)
  for (const body of [{ action: 'update', id: foreign.id, name: 'Przejęty' }, { action: 'delete', id: foreign.id }, { action: 'update', id: 'x' }]) {
    const r = await partners(event.eventId, body)
    assert.equal(r.status, 404, `${body.action}: ${JSON.stringify(r.body)}`)
  }
  assert.equal((await one('event_partners', { id: foreign.id })).name, foreign.name)
  const mixed = await partners(event.eventId, { action: 'reorder', ids: [...(await rows('event_partners', { event_id: event.eventId })).map((p) => p.id), foreign.id] })
  assert.equal(mixed.status, 422)

  await db().from('clubs').update({ registration_enabled: false }).eq('id', clubId)
  try {
    for (const body of [{ action: 'list' }, { action: 'create', name: `Sklep ${rand()}` }]) {
      assert.equal((await partners(event.eventId, body)).status, 404, `disabled ${body.action}`)
    }
  } finally {
    await db().from('clubs').update({ registration_enabled: true }).eq('id', clubId)
  }
})

// ---------------------------------------------------------------- EP-10

test('EP-10 delete: a partner a code holds is 409 partner_referenced and keeps its logo; an unheld one goes with its logo; a legacy logo_url without logo_path is left alone', async () => {
  const event = await paidEvent()
  const held = await create(event.eventId)
  const heldLogo = await uploadLogo()
  await db().from('event_partners').update({ logo_path: heldLogo, logo_url: `${localEnv().url}/storage/v1/object/public/partner-logos/${heldLogo}` }).eq('id', held.id)
  const v = await makeVoucher(event.eventId, { percent: 10, max_uses: 1, partner_id: held.id })
  const listed = (await partners(event.eventId, { action: 'list' })).body.data.partners
  assert.equal(listed.find((p) => p.id === held.id).referenced, true)
  assert.match(listed.find((p) => p.id === held.id).logoUrl, /partner-logos/)
  const refused = await partners(event.eventId, { action: 'delete', id: held.id })
  assert.deepEqual([refused.status, refused.body.code, refused.body.error], [409, 'partner_referenced', REFERENCED])
  assert.ok(await one('event_partners', { id: held.id }), 'the row stays')
  assert.equal(await logoExists(heldLogo), true, 'its logo stays')

  const free = await create(event.eventId)
  const freeLogo = await uploadLogo()
  await db().from('event_partners').update({ logo_path: freeLogo }).eq('id', free.id)
  assert.equal((await partners(event.eventId, { action: 'delete', id: free.id })).status, 200)
  assert.equal(await logoExists(freeLogo), false, 'its logo is removed')

  const legacy = await create(event.eventId)
  const legacyObject = await uploadLogo()
  await db().from('event_partners').update({ logo_url: `${localEnv().url}/storage/v1/object/public/partner-logos/${legacyObject}` }).eq('id', legacy.id)
  assert.equal((await partners(event.eventId, { action: 'delete', id: legacy.id })).status, 200)
  assert.equal(await logoExists(legacyObject), true, 'no logo_path: the object is not touched')
  await bucket().remove([heldLogo, legacyObject])
})

// ---------------------------------------------------------------- EP-11

test('EP-11 partners are outside the money switch: with x-registration-money: off they list and write; organizer-vouchers no longer takes partner actions', async () => {
  const event = await paidEvent()
  const call = async (fn, body) => {
    const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': '203.0.113.19', 'x-registration-money': 'off', cookie: owner.cookie },
      body: JSON.stringify({ eventId: event.eventId, ...body }),
    })
    return { status: res.status, body: await res.json() }
  }
  const created = await call('organizer-partners', { action: 'create', name: 'Sklep' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const listed = await call('organizer-partners', { action: 'list' })
  assert.equal(listed.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.data.partners.length, 1)
  // While PAID_REGISTRATION_ENABLED is true the header changes nothing for vouchers either (V-90):
  // the code dialog's list carries the partners, hidden ones flagged.
  await call('organizer-partners', { action: 'update', id: created.body.data.id, isPublic: false })
  const v = await call('organizer-vouchers', { action: 'list' })
  assert.equal(v.status, 200, JSON.stringify(v.body))
  assert.deepEqual(v.body.data.partners, [{ id: created.body.data.id, name: 'Sklep', isPublic: false }])
  for (const action of ['partner_create', 'partner_update', 'partner_delete']) {
    const r = await call('organizer-vouchers', { action, name: 'Inny', id: created.body.data.id })
    assert.deepEqual([r.status, r.body.code], [400, 'invalid_action'], action)
  }
  assert.equal((await rows('event_partners', { event_id: event.eventId })).length, 1)
})
