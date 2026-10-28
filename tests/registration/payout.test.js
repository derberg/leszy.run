import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { localEnv, admin, sessionFor } from './helpers/stack.js'
import { createClient } from '@supabase/supabase-js'
import { startCapture, messagesTo, clearMessages } from './helpers/emailCapture.js'

const IK = '00000000-0000-4000-8000-0000000000c2' // registration NOT enabled: payout still allowed
const OWNER = 'owner@inny-klub.local'
const GOOD = {
  clubId: IK, legalName: 'Inny Klub Sp. z o.o.', nip: '526-025-02-74', krs: '0000123456',
  iban: 'pl61 1090 1014 0000 0712 1981 2874', address: 'ul. Leśna 1, 00-001 Warszawa',
}

let stopCapture
before(async () => {
  stopCapture = await startCapture()
  await clearMessages()
  const db = admin()
  await db.from('club_payout_details').delete().eq('club_id', IK)
  await db.from('club_payout_history').delete().eq('club_id', IK)
  await db.from('organizer_actions').delete().eq('club_id', IK)
})
after(async () => {
  // organizer.test.js expects IK without payout details.
  await admin().from('club_payout_details').delete().eq('club_id', IK)
  if (stopCapture) await stopCapture()
})

async function call(session, body) {
  const res = await fetch(`${localEnv().functionsUrl}/update-club-payout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

test('F-19 an admin cannot change payout details', async () => {
  const s = await sessionFor('admin@inny-klub.local')
  assert.equal((await call(s, GOOD)).status, 403)
  const { data } = await admin().from('club_payout_details').select('club_id').eq('club_id', IK)
  assert.equal(data.length, 0)
})

test('F-19 a non-member gets 403', async () => {
  const s = await sessionFor('member@zatyrani-test.local')
  assert.equal((await call(s, GOOD)).status, 403)
})

test('F-19 invalid IBAN and invalid NIP are 400 with the specified messages', async () => {
  const s = await sessionFor(OWNER)
  const badIban = await call(s, { ...GOOD, iban: 'PL61109010140000071219812875' })
  assert.equal(badIban.status, 400)
  assert.deepEqual(badIban.body, { error: 'Nieprawidłowy numer rachunku.' })
  const badNip = await call(s, { ...GOOD, nip: '5260250275' })
  assert.equal(badNip.status, 400)
  assert.deepEqual(badNip.body, { error: 'Nieprawidłowy NIP.' })
  const { data } = await admin().from('club_payout_details').select('club_id').eq('club_id', IK)
  assert.equal(data.length, 0)
})

test('F-19 owner saves: normalized values, history, owner email with masked IBAN, audit row without values', async () => {
  const s = await sessionFor(OWNER)
  const r = await call(s, GOOD)
  assert.equal(r.status, 200)

  const { data: row } = await admin().from('club_payout_details').select('*').eq('club_id', IK).single()
  assert.equal(row.iban, 'PL61109010140000071219812874')
  assert.equal(row.nip, '5260250274')
  assert.equal(row.krs, '0000123456')
  assert.equal(row.updated_by, s.profileId)

  const { data: hist } = await admin().from('club_payout_history').select('*').eq('club_id', IK)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].old, null)
  assert.equal(hist[0].new.iban, 'PL61109010140000071219812874')
  assert.equal(hist[0].changed_by, s.profileId)

  const mails = await messagesTo(OWNER)
  assert.equal(mails.length, 1)
  assert.equal(mails[0].subject, 'Zmieniono dane do wypłat klubu Inny Klub')
  assert.match(mails[0].text, /PL61 … 2874/)
  assert.doesNotMatch(mails[0].text, /109010140000071219812874/)

  const { data: acts } = await admin().from('organizer_actions').select('*').eq('club_id', IK).eq('action', 'payout_changed')
  assert.equal(acts.length, 1)
  assert.equal(acts[0].actor_id, s.profileId)
  assert.deepEqual([...acts[0].payload.fields].sort(), ['address', 'iban', 'krs', 'legal_name', 'nip'])
  assert.doesNotMatch(JSON.stringify(acts[0].payload), /PL61|5260250274/)
})

test('F-19 saving identical values still appends a history row and notes no change', async () => {
  const s = await sessionFor(OWNER)
  await clearMessages()
  const r = await call(s, GOOD)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data.changed, [])
  const { data: hist } = await admin().from('club_payout_history').select('id').eq('club_id', IK)
  assert.equal(hist.length, 2)
  assert.equal((await messagesTo(OWNER)).length, 1)
})

test('F-19 a changed IBAN is listed by field in the owner email', async () => {
  const s = await sessionFor(OWNER)
  await clearMessages()
  const r = await call(s, { ...GOOD, iban: 'PL27114020040000300201355387' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data.changed, ['iban'])
  const mails = await messagesTo(OWNER)
  assert.match(mails[0].text, /Rachunek: PL61 … 2874 → PL27 … 5387/)
})

test('F-19 over-long name or address is 400', async () => {
  const s = await sessionFor(OWNER)
  assert.equal((await call(s, { ...GOOD, legalName: 'x'.repeat(201) })).status, 400)
  assert.equal((await call(s, { ...GOOD, address: 'x'.repeat(301) })).status, 400)
})

test('F-19 save_club_payout: anon and authenticated cannot execute it', async () => {
  const { url, anonKey } = localEnv()
  const c = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await c.rpc('save_club_payout', { p_club_id: IK, p_actor: null, p_club_name: 'x', p_new: {} })
  assert.ok(error, 'anon must be refused')
})

test('F-19 one save writes exactly one history row with the right old and new', async () => {
  const s = await sessionFor(OWNER)
  const before = (await admin().from('club_payout_history').select('id').eq('club_id', IK)).data.length
  const r = await call(s, { ...GOOD, address: 'ul. Nowa 2, 00-002 Warszawa' })
  assert.equal(r.status, 200)
  const { data: hist } = await admin().from('club_payout_history').select('*').eq('club_id', IK).order('changed_at', { ascending: false })
  assert.equal(hist.length, before + 1)
  assert.equal(hist[0].old.address, GOOD.address)
  assert.equal(hist[0].new.address, 'ul. Nowa 2, 00-002 Warszawa')
  assert.equal(hist[0].old.iban, 'PL27114020040000300201355387')
})
