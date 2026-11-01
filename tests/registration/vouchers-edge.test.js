// Plan 7, task 5: the organizer's vouchers and partners (organizer-vouchers), the partner of one
// entry (organizer-entry-action `partner`), the B3 partner column and count
// (list-event-registrations) and the CSV (export-event-registrations), plus the partner-leak walk
// of every runner-facing answer and e-mail (Review Focus 5). Scenarios V-30…V-34 and V-38 in
// docs/registration/scenario-matrix.md. LOCAL stack plus the mocked dpay and the e-mail capture.
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import {
  consentIds, createOrder, db, expireNow, one, orderOf, orderOk, person, registrationsOf, rows, rpc, runnerEmail,
} from './helpers/orders.js'
import { adult, isDeadlock, orderGroup } from './helpers/groups.js'
import { makeVoucher, vouchersMade } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'

const PRICE = 6000
const DISCOUNTED = 5100 // 15 %
const BIEG = (capacity = 200) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const USED = 'Kodu, który już wykorzystano, nie można zmienić — wyłącz go.'
const TAKEN = 'Ten kod już istnieje.'
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

let owner, adminS, member, outsider, innyAdmin, clubId, stopCapture, stopMock, eventHandler, sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 2, onnotice: () => {} }))

before(async () => {
  const { url, anonKey } = localEnv()
  process.env.VITE_SUPABASE_URL = url
  process.env.VITE_SUPABASE_ANON_KEY = anonKey
  ;({ default: eventHandler } = await import('../../public/api/event.js'))
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  clubId = await acceptAgreement('zatyrani-test')
  ;[owner, adminS, member, outsider, innyAdmin] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local',
    runnerEmail('outsider'), 'admin@inny-klub.local',
  ].map(sessionFor))
})
after(async () => {
  if (sqlClient) await sqlClient.end()
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })
afterEach(async () => {
  const ids = [...vouchersMade]
  vouchersMade.clear()
  for (const id of ids) await assertVoucherInvariant(id)
})

const rand = () => crypto.randomBytes(4).toString('hex')
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const paidEvent = () => createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': PRICE }, competitions: BIEG() })
/** Two competitions at PRICE: the one sold in, and a second a code can be linked to or not. */
const twoCompetitions = () => createPublishedPaidEvent(owner, {
  prices: { 'Bieg 9 km': PRICE, 'Bieg 5 km': PRICE },
  competitions: [...BIEG(), { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 200 }],
})
const vouchers = (eventId, body, session = owner) => callFn('organizer-vouchers', session, { eventId, ...body })
const actions = (eventId, action) => rows('organizer_actions', { event_id: eventId, action })
const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

/** A voucher made through organizer-vouchers `create` → its row (remembered for the invariant). */
async function createVoucher(eventId, over = {}) {
  const r = await vouchers(eventId, { action: 'create', code: `KOD-${rand().toUpperCase()}`, percent: 15, maxUses: 5, ...over })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  vouchersMade.add(r.body.data.id)
  return one('vouchers', { id: r.body.data.id })
}

async function createPartner(eventId, name = `Sklep ${rand()}`, note = null) {
  const r = await vouchers(eventId, { action: 'partner_create', name, note })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { id: r.body.data.id, name, note }
}

/** A pending order through create_order with the code on its one person → { orderId, registrationId }. */
async function orderWithCode(event, code, email = runnerEmail('code')) {
  const out = await orderOk(event, { people: [person(email, { voucherCode: code })], displayed: DISCOUNTED })
  const [reg] = await registrationsOf(out.orderId)
  return { orderId: out.orderId, registrationId: reg.id, email }
}

// ---------------------------------------------------------------- V-30

test('V-30 organizer-vouchers: a member, an outsider, another club\'s admin and a disabled club get 404; owner and admin 200', async () => {
  const event = await paidEvent()
  const reads = { action: 'list' }
  const writes = { action: 'partner_create', name: `Sklep ${rand()}` }
  for (const [who, session] of [['member', member], ['outsider', outsider], ['innyAdmin', innyAdmin]]) {
    for (const body of [reads, writes, { action: 'export' }]) {
      const r = await vouchers(event.eventId, body, session)
      assert.equal(r.status, 404, `${who} ${body.action}: ${JSON.stringify(r.body)}`)
    }
  }
  assert.deepEqual(await rows('registration_partners', { event_id: event.eventId }), [], 'no refused write landed')
  for (const [who, session] of [['owner', owner], ['admin', adminS]]) {
    const r = await vouchers(event.eventId, reads, session)
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`)
    assert.deepEqual(r.body.data, { vouchers: [], partners: [] })
  }
  assert.equal((await vouchers(event.eventId, { action: 'partner_create', name: `Sklep ${rand()}` }, adminS)).status, 201)
  // Another event's voucher id: 404, never a write on it.
  const other = await paidEvent()
  const foreign = await createVoucher(other.eventId)
  assert.equal((await vouchers(event.eventId, { action: 'disable', id: foreign.id })).status, 404)
  assert.equal((await one('vouchers', { id: foreign.id })).disabled_at, null)
  // No session: 401. An unknown action: 400.
  assert.equal((await vouchers(event.eventId, reads, null)).status, 401)
  assert.equal((await vouchers(event.eventId, { action: 'drop_table' })).status, 400)

  await db().from('clubs').update({ registration_enabled: false }).eq('id', clubId)
  try {
    for (const body of [reads, writes]) assert.equal((await vouchers(event.eventId, body)).status, 404, `disabled ${body.action}`)
  } finally {
    await db().from('clubs').update({ registration_enabled: true }).eq('id', clubId)
  }
})

// ---------------------------------------------------------------- V-31

test('V-31 generate { n: 20, percent: 15 } → 20 single-use codes, one vouchers_generated row with n 20 and no code in any payload', async () => {
  const event = await paidEvent()
  const partner = await createPartner(event.eventId)
  const r = await vouchers(event.eventId, { action: 'generate', n: 20, percent: 15, prefix: 'wiosna', partnerId: partner.id, note: 'ulotki' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.data.count, 20)
  const made = await rows('vouchers', { event_id: event.eventId })
  for (const v of made) vouchersMade.add(v.id)
  assert.equal(made.length, 20)
  assert.equal(new Set(made.map((v) => v.code)).size, 20)
  for (const v of made) {
    assert.deepEqual([v.max_uses, v.percent, v.used, v.partner_id, v.note], [1, 15, 0, partner.id, 'ulotki'])
    assert.match(v.code, /^WIOSNA-[A-HJ-NP-Z2-9]{8}$/)
  }
  const logged = await actions(event.eventId, 'vouchers_generated')
  assert.equal(logged.length, 1)
  assert.deepEqual(logged[0].payload, { n: 20 })
  // A code is a bearer discount: no audit row of the event holds one, the prefix included.
  await vouchers(event.eventId, { action: 'create', code: 'JEDEN-KOD', percent: 10, maxUses: 3 })
  await vouchers(event.eventId, { action: 'export' })
  const audit = JSON.stringify(await rows('organizer_actions', { event_id: event.eventId }))
  for (const v of [...made, { code: 'JEDEN-KOD' }]) assert.ok(!audit.includes(v.code), v.code)
  assert.ok(!/wiosna/i.test(audit))
  for (const v of await rows('vouchers', { event_id: event.eventId })) vouchersMade.add(v.id)

  // The list answers what the panel shows; 201 and 0 → 422 with nothing written.
  const list = await vouchers(event.eventId, { action: 'list' })
  assert.equal(list.body.data.vouchers.length, 21)
  const one20 = list.body.data.vouchers.find((v) => v.code.startsWith('WIOSNA-'))
  assert.deepEqual([one20.percent, one20.used, one20.maxUses, one20.partner, one20.note, one20.disabled],
    [15, 0, 1, { id: partner.id, name: partner.name }, 'ulotki', false])
  for (const n of [201, 0, 'x']) {
    const bad = await vouchers(event.eventId, { action: 'generate', n, percent: 15 })
    assert.equal(bad.status, 422, `${n}: ${JSON.stringify(bad.body)}`)
  }
  assert.equal((await rows('vouchers', { event_id: event.eventId })).length, 21)
})

test('V-31 generate makes single-use codes whatever maxUses the body sends', async () => {
  const event = await paidEvent()
  const r = await vouchers(event.eventId, { action: 'generate', n: 3, percent: 15, maxUses: 5 })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const made = await rows('vouchers', { event_id: event.eventId })
  for (const v of made) vouchersMade.add(v.id)
  assert.deepEqual(made.map((v) => v.max_uses), [1, 1, 1])
})

test('V-31 create: a typed code is stored upper case; the same code in any case → 409 code_taken „Ten kod już istnieje.”; a foreign partner or competition → 422', async () => {
  const event = await paidEvent()
  const other = await paidEvent()
  const code = `Leszy-${rand()}`
  const v = await createVoucher(event.eventId, { code, validUntil: '2026-12-31', categoryIds: [event.categoryIds[0]] })
  assert.equal(v.code, code.toUpperCase())
  const again = await vouchers(event.eventId, { action: 'create', code: code.toLowerCase(), percent: 10, maxUses: 1 })
  assert.deepEqual([again.status, again.body.code, again.body.error], [409, 'code_taken', TAKEN])
  // The same code on another event is a different code.
  vouchersMade.add((await createVoucher(other.eventId, { code })).id)
  const foreignPartner = await createPartner(other.eventId)
  const fp = await vouchers(event.eventId, { action: 'create', percent: 10, maxUses: 1, partnerId: foreignPartner.id })
  assert.deepEqual([fp.status, fp.body.code], [422, 'invalid_partner'])
  const fc = await vouchers(event.eventId, { action: 'create', percent: 10, maxUses: 1, categoryIds: [other.categoryIds[0]] })
  assert.deepEqual([fc.status, fc.body.code], [422, 'invalid_category'])
  // No code → one is generated.
  const gen = await vouchers(event.eventId, { action: 'create', percent: 10, maxUses: 1 })
  assert.equal(gen.status, 201, JSON.stringify(gen.body))
  vouchersMade.add(gen.body.data.id)
  assert.match(gen.body.data.code, /^[A-HJ-NP-Z2-9]{8}$/)
  const list = (await vouchers(event.eventId, { action: 'list' })).body.data.vouchers
  const typed = list.find((x) => x.id === v.id)
  assert.deepEqual([typed.validUntil, typed.categoryIds], ['2026-12-31', [event.categoryIds[0]]])
  assert.equal((await actions(event.eventId, 'voucher_created')).length, 2)
})

// ---------------------------------------------------------------- V-32

test('V-32 ruling 11: a used code keeps its percent and code (409), maxUses never below used (409), disable → the next claim voucher_invalid, delete only while unreferenced', async () => {
  const event = await paidEvent()
  const v = await createVoucher(event.eventId, { maxUses: 3 })
  await orderWithCode(event, v.code)
  await orderWithCode(event, v.code)
  assert.equal((await one('vouchers', { id: v.id })).used, 2)

  for (const change of [{ percent: 20 }, { code: `INNY-${rand()}` }]) {
    const r = await vouchers(event.eventId, { action: 'update', id: v.id, ...change })
    assert.deepEqual([r.status, r.body.code, r.body.error], [409, 'voucher_used', USED], JSON.stringify(change))
  }
  const below = await vouchers(event.eventId, { action: 'update', id: v.id, maxUses: 1 })
  assert.deepEqual([below.status, below.body.code, below.body.error],
    [409, 'below_used', 'Limit nie może być mniejszy niż liczba dotychczasowych użyć.'])
  // The same percent, maxUses down to exactly used, a note and a date: allowed.
  const ok = await vouchers(event.eventId, { action: 'update', id: v.id, percent: 15, maxUses: 2, note: 'tylko 2', validUntil: '2026-12-31' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(ok.body.data.changed.sort(), ['max_uses', 'note', 'valid_until'])
  const stored = await one('vouchers', { id: v.id })
  assert.deepEqual([stored.percent, stored.code, stored.max_uses, stored.note], [15, v.code, 2, 'tylko 2'])
  const updated = await actions(event.eventId, 'voucher_updated')
  assert.equal(updated.length, 1)
  assert.deepEqual(updated[0].payload.fields.sort(), ['max_uses', 'note', 'valid_until'])

  // An unused code may still change its percent and code.
  const fresh = await createVoucher(event.eventId)
  const newCode = `NOWY-${rand().toUpperCase()}`
  const edit = await vouchers(event.eventId, { action: 'update', id: fresh.id, percent: 50, code: newCode })
  assert.equal(edit.status, 200, JSON.stringify(edit.body))
  assert.deepEqual([(await one('vouchers', { id: fresh.id })).percent, (await one('vouchers', { id: fresh.id })).code], [50, newCode])

  // Delete: refused while referenced, done once nothing holds it.
  const del = await vouchers(event.eventId, { action: 'delete', id: v.id })
  assert.deepEqual([del.status, del.body.code], [409, 'voucher_referenced'])
  assert.ok(await one('vouchers', { id: v.id }))
  const gone = await vouchers(event.eventId, { action: 'delete', id: fresh.id })
  assert.equal(gone.status, 200, JSON.stringify(gone.body))
  vouchersMade.delete(fresh.id)
  assert.equal(await one('vouchers', { id: fresh.id }), null)
  assert.equal((await actions(event.eventId, 'voucher_deleted')).length, 1)

  // Disable: the next claim of a code with uses left is voucher_invalid.
  const live = await createVoucher(event.eventId, { maxUses: 5 })
  const dis = await vouchers(event.eventId, { action: 'disable', id: live.id })
  assert.equal(dis.status, 200, JSON.stringify(dis.body))
  assert.ok((await one('vouchers', { id: live.id })).disabled_at)
  const refused = await createOrder(event, { people: [person(runnerEmail('dis'), { voucherCode: live.code })], displayed: DISCOUNTED })
  assert.equal(refused.error?.message, 'voucher_invalid:0')
  assert.equal((await one('vouchers', { id: live.id })).used, 0)
  assert.equal((await vouchers(event.eventId, { action: 'list' })).body.data.vouchers.find((x) => x.id === live.id).disabled, true)
  assert.equal((await actions(event.eventId, 'voucher_disabled')).length, 1)
})

// ---------------------------------------------------------------- V-33

test('V-33 a partner set by hand on an entry without a voucher → the B3 row names it; partners[].count counts live entries only', async () => {
  const event = await paidEvent()
  const partner = await createPartner(event.eventId, `Sklep Biegacz ${rand()}`)
  const a = await orderOk(event, { emails: [runnerEmail('pa')] })
  const b = await orderOk(event, { emails: [runnerEmail('pb')] })
  const [ra] = await registrationsOf(a.orderId)
  const [rb] = await registrationsOf(b.orderId)
  assert.equal(ra.voucher_id, null)
  for (const reg of [ra, rb]) {
    const r = await callFn('organizer-entry-action', owner, { action: 'partner', registrationId: reg.id, partnerId: partner.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data, { partnerId: partner.id, changed: true })
  }
  // The second entry leaves live: still attributed, no longer counted.
  const cancel = await callFn('organizer-entry-action', owner, { action: 'cancel', registrationId: rb.id })
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body))
  const list = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const row = list.body.data.find((x) => x.id === ra.id)
  assert.deepEqual([row.partnerId, row.partnerName, row.voucherCode], [partner.id, partner.name, null])
  assert.equal(list.body.data.find((x) => x.id === rb.id).partnerName, partner.name)
  assert.deepEqual(list.body.partners, [{ id: partner.id, name: partner.name, count: 1 }])
  // An entry no longer live, another event's partner, a bad id: refused, nothing written.
  const dead = await callFn('organizer-entry-action', owner, { action: 'partner', registrationId: rb.id, partnerId: null })
  assert.deepEqual([dead.status, dead.body.code], [409, 'not_live'])
  const other = await paidEvent()
  const foreign = await createPartner(other.eventId)
  const fr = await callFn('organizer-entry-action', owner, { action: 'partner', registrationId: ra.id, partnerId: foreign.id })
  assert.deepEqual([fr.status, fr.body.code], [422, 'invalid_partner'])
  assert.equal((await callFn('organizer-entry-action', owner, { action: 'partner', registrationId: ra.id, partnerId: 'x' })).status, 422)
  // Clearing takes an explicit null: a missing or misnamed key wipes nothing.
  for (const typo of [{}, { partner_id: null }]) {
    const r = await callFn('organizer-entry-action', owner, { action: 'partner', registrationId: ra.id, ...typo })
    assert.deepEqual([r.status, r.body.code], [422, 'invalid_partner'], JSON.stringify(typo))
  }
  assert.equal((await one('registrations', { id: ra.id })).partner_id, partner.id)
  // A member may not; the audit names the target and the partner id, nothing personal.
  assert.equal((await callFn('organizer-entry-action', member, { action: 'partner', registrationId: ra.id, partnerId: null })).status, 403)
  const logged = await actions(event.eventId, 'registration_partner_set')
  assert.equal(logged.length, 2)
  assert.deepEqual(logged.map((l) => l.payload.partnerId), [partner.id, partner.id])
  // A partner somebody carries cannot be deleted; cleared, then deleted.
  const del = await vouchers(event.eventId, { action: 'partner_delete', id: partner.id })
  assert.deepEqual([del.status, del.body.code], [409, 'partner_referenced'])
  // The same name in another case is taken; a rename is logged.
  const dup = await vouchers(event.eventId, { action: 'partner_create', name: partner.name.toUpperCase() })
  assert.deepEqual([dup.status, dup.body.code], [409, 'partner_taken'])
  const ren = await vouchers(event.eventId, { action: 'partner_update', id: partner.id, name: `${partner.name} 2`, note: 'umowa' })
  assert.equal(ren.status, 200, JSON.stringify(ren.body))
  const clear = await callFn('organizer-entry-action', owner, { action: 'partner', registrationId: ra.id, partnerId: null })
  assert.deepEqual(clear.body.data, { partnerId: null, changed: true })
  const spare = await createPartner(event.eventId)
  assert.equal((await vouchers(event.eventId, { action: 'partner_delete', id: spare.id })).status, 200)
  for (const name of ['partner_created', 'partner_updated', 'partner_deleted']) {
    assert.ok((await actions(event.eventId, name)).length >= 1, name)
  }
})

// ---------------------------------------------------------------- V-34

test('V-34 the CSV fills Partner and Kod rabatowy; a partner named =HYPERLINK(1) is escaped, in the entries CSV and the codes CSV', async () => {
  const event = await paidEvent()
  const partner = await createPartner(event.eventId, '=HYPERLINK(1)', '@notatka')
  const v = await createVoucher(event.eventId, { partnerId: partner.id, note: '+notatka' })
  const { registrationId } = await orderWithCode(event, v.code)
  assert.equal((await one('registrations', { id: registrationId })).partner_id, partner.id)

  const r = await callFn('export-event-registrations', owner, { eventId: event.eventId, filter: { partnerId: partner.id } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const [header, line] = r.body.data.csv.replace(/^﻿/, '').split('\r\n')
  const titles = header.split(';').map((h) => h.slice(1, -1))
  const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1])
  assert.equal(cells[titles.indexOf('Partner')], "'=HYPERLINK(1)")
  assert.equal(cells[titles.indexOf('Kod rabatowy')], v.code)
  assert.equal(titles.indexOf('Kod rabatowy'), titles.indexOf('Partner') + 1)

  const codes = await vouchers(event.eventId, { action: 'export' })
  assert.equal(codes.status, 200, JSON.stringify(codes.body))
  assert.match(codes.body.data.filename, /^kody-.+-\d{4}-\d{2}-\d{2}\.csv$/)
  const [vh, vl] = codes.body.data.csv.split('\r\n')
  assert.equal(vh, '﻿"Kod";"Rabat";"Wykorzystano";"Limit";"Ważny do";"Partner";"Notatka"')
  assert.equal(vl, `"${v.code}";"15%";"1";"5";"";"'=HYPERLINK(1)";"'+notatka"`)
  const exported = await actions(event.eventId, 'vouchers_exported')
  assert.equal(exported.length, 1)
  assert.deepEqual(exported[0].payload, { rows: 1 })
})

// ---------------------------------------------------------------- V-38

/** Every key at every depth of a JSON value. */
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
  return out
}

function assertNoPartner(what, value, secrets) {
  const keys = [...keysDeep(value)].filter((k) => /partner/i.test(k))
  assert.deepEqual(keys, [], `${what}: partner keys`)
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const s of secrets) assert.ok(!text.includes(s), `${what} holds "${s}"`)
}

async function waitForMail(email, pred, what) {
  for (let i = 0; i < 60; i++) {
    const msgs = await messagesTo(email)
    if (msgs.some(pred)) return msgs
    await sleep(250)
  }
  assert.fail(`timed out waiting for ${what} to ${email}`)
}

async function jobsRun() {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET }, body: '{}',
  })
  assert.equal(res.status, 200, await res.text())
}

async function getEvent(slug) {
  const res = { statusCode: 0, setHeader() {}, end(body) { this.body = body } }
  await eventHandler({ url: `/api/event?slug=${slug}`, method: 'GET', headers: {} }, res)
  return JSON.parse(res.body)
}

test('V-38 a partnered code on a confirmed entry: no runner-facing answer or e-mail carries a partner key, the partner\'s name or note, or the voucher note', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const partner = await createPartner(event.eventId, `Sklep Tajny ${rand()}`, `Umowa poufna ${rand()}`)
  const voucherNote = `Notatka wewnętrzna ${rand()}`
  const v = await createVoucher(event.eventId, { maxUses: 10, partnerId: partner.id, note: voucherNote })
  const secrets = [partner.name, partner.note, voucherNote, partner.id]
  const { slug } = await one('registration_settings', { event_id: event.eventId })

  // The runner pays for herself and an added adult, both on the code (create-order, the real path).
  const me = runnerEmail('leak')
  const added = runnerEmail('leakadult')
  const runner = await sessionFor(me)
  const grownUp = (email, over = {}) => ({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', ...over })
  const created = await call('create-order', {
    people: [
      { categoryId: c9, person: grownUp(me), voucherCode: v.code },
      { categoryId: c9, person: grownUp(added, { firstName: 'Piotr', lastName: 'Leśny', gender: 'M' }), voucherCode: v.code },
    ],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true, displayedTotal: 2 * DISCOUNTED,
  }, runner)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { orderId } = created.body.data
  const regs = await registrationsOf(orderId)
  assert.deepEqual(regs.map((x) => x.partner_id), [partner.id, partner.id])

  // Payment reminder (organizer), then the payment (IPN) → confirmation and the consent request.
  const remind = await callFn('organizer-entry-action', owner, { action: 'remind_payment', orderId })
  assert.equal(remind.status, 200, JSON.stringify(remind.body))
  const [attempt] = await rows('payment_attempts', { order_id: orderId })
  await payMock(attempt.dpay_transaction_id, 'paid')
  await waitForMail(me, (m) => m.subject.startsWith('Opłacone'), 'confirmation')
  await waitForMail(added, () => true, 'consent request')
  assert.equal((await orderOf(orderId)).status, 'paid')

  // A partial organizer refund → the refund e-mail.
  const mine = regs.find((x) => x.email === me)
  const [line] = await rows('order_lines', { registration_id: mine.id })
  const refund = await callFn('organizer-refund', owner, { lineId: line.id, grosze: 100, requestKey: crypto.randomUUID() })
  assert.equal(refund.status, 200, JSON.stringify(refund.body))
  await waitForMail(me, (m) => m.subject.startsWith('Zwrot'), 'refund')

  // Another runner's order on the same code expires → „Zgłoszenie wygasło”.
  const late = runnerEmail('leakexp')
  const lateRunner = await sessionFor(late)
  const lateOrder = await call('create-order', {
    people: [{ categoryId: c9, person: grownUp(late), voucherCode: v.code }],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true, displayedTotal: DISCOUNTED,
  }, lateRunner)
  assert.equal(lateOrder.status, 201, JSON.stringify(lateOrder.body))
  const [lateAttempt] = await rows('payment_attempts', { order_id: lateOrder.body.data.orderId })
  await payMock(lateAttempt.dpay_transaction_id, 'declined')
  await db().from('payment_attempts').update({ created_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('dpay_transaction_id', lateAttempt.dpay_transaction_id)
  assert.ok(await expireNow(lateOrder.body.data.orderId) >= 1)
  for (let i = 0; i < 40 && !(await messagesTo(late)).length; i++) await jobsRun()
  await waitForMail(late, (m) => m.subject.startsWith('Zgłoszenie wygasło'), 'expiry')

  // The runner-facing answers.
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const startList = await anon.rpc('start_list', { p_event_id: event.eventId })
  assert.ifError(startList.error)
  const answers = {
    start_list: startList.data,
    '/api/event': await getEvent(slug),
    'order-status': (await call('order-status', { orderId }, runner)).body,
    'my-event-registrations': (await call('my-event-registrations', { slug }, runner)).body,
    'export-my-data': (await call('export-my-data', {}, runner)).body,
  }
  assert.ok(answers['order-status'].data, JSON.stringify(answers['order-status']))
  assert.ok(Array.isArray(answers['my-event-registrations'].data), JSON.stringify(answers['my-event-registrations']))
  assert.ok(answers['export-my-data'].registrations ?? answers['export-my-data'].data, 'export-my-data answered')
  for (const [what, value] of Object.entries(answers)) assertNoPartner(what, value, secrets)
  // The code is the runner's own: never on the public answers.
  // order-status and export-my-data are the buyer's own order, the one place the code may appear.
  for (const what of ['start_list', '/api/event', 'my-event-registrations']) {
    assert.ok(!JSON.stringify(answers[what]).includes(v.code), `${what} holds the code`)
  }

  // Every e-mail any of the three received.
  const mails = [...await messagesTo(me), ...await messagesTo(added), ...await messagesTo(late)]
  const subjects = mails.map((m) => m.subject.split(' — ')[0])
  for (const s of ['Opłacone', 'Zwrot 1,00 zł', 'Zgłoszenie wygasło']) assert.ok(subjects.includes(s), `${s} in ${subjects}`)
  assert.ok(subjects.some((s) => s.startsWith('Przypomnienie') || /wpłat/i.test(s)), `a payment reminder in ${subjects}`)
  assert.ok((await messagesTo(added)).length >= 1, 'the consent request')
  for (const m of mails) assertNoPartner(`e-mail „${m.subject}”`, { text: m.text, html: m.html ?? '', subject: m.subject }, secrets)
  // The code is allowed only on the order lines of the buyer's confirmation: never in what an added
  // adult or another holder of the code receives, nor in any other mail to the buyer.
  const ownLines = (m) => m.to === me && m.subject.startsWith('Opłacone')
  for (const m of mails.filter((x) => !ownLines(x))) {
    assert.ok(!`${m.subject} ${m.text} ${m.html ?? ''}`.includes(v.code), `e-mail „${m.subject}” to ${m.to} holds the code`)
  }
})

// ---------------------------------------------------------------- V-35 locks and tenancy

const CAN = (role, fn) => sql()`select has_function_privilege(${role}, ${fn}, 'EXECUTE') as ok`.then(([r]) => r.ok)

test('V-35 create_vouchers, update_voucher and set_registration_partner: service_role only, SECURITY DEFINER, search_path=\'\'', async () => {
  for (const fn of ['public.create_vouchers(uuid, jsonb, uuid)', 'public.update_voucher(uuid, jsonb, uuid)',
    'public.set_registration_partner(uuid, uuid, uuid)']) {
    assert.deepEqual([await CAN('anon', fn), await CAN('authenticated', fn), await CAN('service_role', fn)], [false, false, true], fn)
    assert.equal(await CAN('public', fn), false, fn)
  }
  const procs = await sql()`
    select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('create_vouchers', 'update_voucher', 'set_registration_partner')`
  assert.equal(procs.length, 3)
  for (const p of procs) {
    assert.equal(p.prosecdef, true, p.proname)
    assert.ok(p.proconfig?.includes('search_path=""'), `${p.proname}: ${p.proconfig}`)
  }
})

test('V-35 another event\'s ids: update, delete and the partner actions 404, a foreign partner or competition on update 422, another club\'s manager 404 on an entry', async () => {
  const event = await paidEvent()
  const other = await paidEvent()
  const mine = await createVoucher(event.eventId)
  const foreign = await createVoucher(other.eventId)
  const foreignPartner = await createPartner(other.eventId)
  const myPartner = await createPartner(event.eventId)
  for (const body of [
    { action: 'update', id: foreign.id, percent: 50 },
    { action: 'delete', id: foreign.id },
    { action: 'partner_update', id: foreignPartner.id, name: 'Przejęty' },
    { action: 'partner_delete', id: foreignPartner.id },
  ]) {
    const r = await vouchers(event.eventId, body)
    assert.equal(r.status, 404, `${body.action}: ${JSON.stringify(r.body)}`)
  }
  assert.equal((await one('vouchers', { id: foreign.id })).percent, 15)
  assert.equal((await one('registration_partners', { id: foreignPartner.id })).name, foreignPartner.name)
  const fp = await vouchers(event.eventId, { action: 'update', id: mine.id, partnerId: foreignPartner.id })
  assert.deepEqual([fp.status, fp.body.code], [422, 'invalid_partner'])
  const fc = await vouchers(event.eventId, { action: 'update', id: mine.id, categoryIds: [other.categoryIds[0]] })
  assert.deepEqual([fc.status, fc.body.code], [422, 'invalid_category'])
  const stored = await one('vouchers', { id: mine.id })
  assert.equal(stored.partner_id, null)
  assert.deepEqual(await rows('voucher_competitions', { voucher_id: mine.id }), [])

  const { orderId } = await orderOk(event, { emails: [runnerEmail('tenant')] })
  const [reg] = await registrationsOf(orderId)
  const r = await callFn('organizer-entry-action', innyAdmin, { action: 'partner', registrationId: reg.id, partnerId: myPartner.id })
  assert.equal(r.status, 404, JSON.stringify(r.body))
  assert.equal((await one('registrations', { id: reg.id })).partner_id, null)
})

/**
 * Runs `first` in a transaction holding its locks, starts `writer` beside it, gives the writer time
 * to park, then runs `then` in the same transaction. → the writer's result. A transaction that
 * deadlocks throws out of here, or the writer comes back with 40P01.
 */
async function interleave(first, writer, then) {
  let running
  await sql().begin(async (tx) => {
    await first(tx)
    running = Promise.resolve(writer())
    await sleep(300)
    await then(tx)
  })
  return running
}

test('V-36 I-1 update_voucher against create_order\'s order of locks: competition then voucher, no deadlock', async () => {
  const event = await twoCompetitions()
  const [c] = event.categoryIds
  const v = await createVoucher(event.eventId)
  const r = await interleave(
    (tx) => tx`select 1 from public.competitions where category_id = ${c} for update`, // create_order's competition lock
    () => rpc('update_voucher', { p_voucher_id: v.id, p_fields: { category_ids: [c] }, p_actor: null }),
    (tx) => tx`select 1 from public.vouchers where id = ${v.id} for update`, // and then its claim
  )
  assert.equal(r.error, null, JSON.stringify(r.error))
  assert.equal((await rows('voucher_competitions', { voucher_id: v.id })).length, 1)
})

test('V-36 I-1 create_vouchers against publish_changes\' order of locks: competition then settings, no deadlock', async () => {
  const event = await twoCompetitions()
  const [c] = event.categoryIds
  const code = `KOD-${rand().toUpperCase()}`
  const r = await interleave(
    (tx) => tx`select 1 from public.competitions where category_id = ${c} for update`,
    () => rpc('create_vouchers', {
      p_event_id: event.eventId, p_actor: null,
      p_items: [{ code, percent: 15, max_uses: 5, valid_until: null, partner_id: null, note: null, category_ids: [c] }],
    }),
    (tx) => tx`select 1 from public.registration_settings where event_id = ${event.eventId} for update`,
  )
  assert.equal(r.error, null, JSON.stringify(r.error))
  const [v] = await rows('vouchers', { event_id: event.eventId })
  vouchersMade.add(v.id)
  assert.equal(v.code, code)
})

test('V-36 I-1 30 rounds of update_voucher relinking a code while create_order sells it: no 40P01, the voucher invariant holds', async () => {
  const event = await twoCompetitions()
  const [c, spare] = event.categoryIds
  const v = await createVoucher(event.eventId, { maxUses: 1000, categoryIds: [c] })
  const rs = []
  for (let round = 0; round < 30; round++) {
    const links = round % 2 ? [c] : [c, spare]
    rs.push(...await Promise.all([
      rpc('update_voucher', { p_voucher_id: v.id, p_fields: { category_ids: links }, p_actor: null }),
      ...[0, 1, 2].map(() => orderGroup(event, [{ ...adult(c, 'self'), voucherCode: v.code }], { displayed: DISCOUNTED })),
    ]))
  }
  assert.deepEqual(rs.filter(isDeadlock).map((r) => r.error.message), [], 'no deadlock')
  assert.deepEqual(rs.filter((r) => r.error).map((r) => r.error.message), [], 'nothing refused')
  assert.equal((await one('vouchers', { id: v.id })).used, 90)
})

test('V-36 ruling 11 under the row lock: an edit waiting on a claim sees the use that landed (voucher_used, below_used), and the percent stays', async () => {
  const event = await twoCompetitions()
  const [c] = event.categoryIds
  const claim = (tx, v) => tx`select * from public.claim_registration_voucher(${event.eventId}, ${v.code}, ${c}, ${v.id})`
  // These claims hold no registration, so these vouchers stay out of the invariant.
  const percent = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const limit = await makeVoucher(event.eventId, { percent: 15, max_uses: 2 })
  vouchersMade.delete(percent.id)
  vouchersMade.delete(limit.id)
  await claim(sql(), limit)

  const a = await interleave((tx) => claim(tx, percent),
    () => rpc('update_voucher', { p_voucher_id: percent.id, p_fields: { percent: 50 }, p_actor: null }), async () => {})
  assert.equal(a.error?.message, 'voucher_used', JSON.stringify(a))
  assert.deepEqual([(await one('vouchers', { id: percent.id })).percent, (await one('vouchers', { id: percent.id })).used], [15, 1])

  const b = await interleave((tx) => claim(tx, limit),
    () => rpc('update_voucher', { p_voucher_id: limit.id, p_fields: { max_uses: 1 }, p_actor: null }), async () => {})
  assert.equal(b.error?.message, 'below_used', JSON.stringify(b))
  assert.deepEqual([(await one('vouchers', { id: limit.id })).max_uses, (await one('vouchers', { id: limit.id })).used], [2, 2])
})
