import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { localEnv, admin, sessionFor } from './helpers/stack.js'
import { startCapture, messagesTo, clearMessages } from './helpers/emailCapture.js'

const OPERATOR = 'operator@leszy.test' // PIPELINE_ALERT_EMAIL in functions.env
const ZT = '00000000-0000-4000-8000-0000000000c1' // enabled
const IK = '00000000-0000-4000-8000-0000000000c2' // disabled
const VERSION = '2026-11-v1'

let stopCapture
before(async () => {
  stopCapture = await startCapture()
  await clearMessages()
  const db = admin()
  await db.from('registration_waitlist').delete().eq('club_id', IK)
  await db.from('organizer_agreements').delete().in('club_id', [ZT, IK])
  await db.from('organizer_actions').delete().in('club_id', [ZT, IK])
})
after(async () => { if (stopCapture) await stopCapture() })

async function call(fn, session, body) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

test('F-17 status of a disabled club for a member: enabled false', async () => {
  const s = await sessionFor('member@inny-klub.local')
  const r = await call('organizer-status', s, { clubId: IK })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data, {
    enabled: false, waitlisted: false, agreementAccepted: false, version: VERSION, payoutConfigured: false, role: 'member',
  })
})

test('F-17 status of an enabled club says enabled true', async () => {
  const s = await sessionFor('owner@zatyrani-test.local')
  const r = await call('organizer-status', s, { clubId: ZT })
  assert.equal(r.body.data.enabled, true)
  assert.equal(r.body.data.role, 'owner')
})

test('F-17 status for a non-member is 403', async () => {
  const s = await sessionFor('member@zatyrani-test.local')
  assert.equal((await call('organizer-status', s, { clubId: IK })).status, 403)
})

test('F-17 a plain member cannot join the waitlist', async () => {
  const s = await sessionFor('member@inny-klub.local')
  assert.equal((await call('join-registration-waitlist', s, { clubId: IK })).status, 403)
})

test('F-17 waitlist join by admin: one row, one operator email; a second join changes nothing', async () => {
  const s = await sessionFor('admin@inny-klub.local')
  const r1 = await call('join-registration-waitlist', s, { clubId: IK })
  assert.equal(r1.status, 200)
  const r2 = await call('join-registration-waitlist', s, { clubId: IK })
  assert.equal(r2.status, 200)

  const { data: rows } = await admin().from('registration_waitlist').select('*').eq('club_id', IK)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requested_by, s.profileId)
  const mails = await messagesTo(OPERATOR)
  assert.equal(mails.length, 1)
  assert.match(mails[0].text, /Inny Klub/)

  const status = await call('organizer-status', s, { clubId: IK })
  assert.equal(status.body.data.waitlisted, true)
})

test('F-18 agreement: admin 403, non-member 403, stale version 409, disabled club 404', async () => {
  const adminS = await sessionFor('admin@zatyrani-test.local')
  assert.equal((await call('accept-organizer-agreement', adminS, { clubId: ZT, version: VERSION })).status, 403)
  const outsider = await sessionFor('member@inny-klub.local')
  assert.equal((await call('accept-organizer-agreement', outsider, { clubId: ZT, version: VERSION })).status, 403)
  const owner = await sessionFor('owner@zatyrani-test.local')
  assert.equal((await call('accept-organizer-agreement', owner, { clubId: ZT, version: 'old' })).status, 409)
  const ikOwner = await sessionFor('owner@inny-klub.local')
  assert.equal((await call('accept-organizer-agreement', ikOwner, { clubId: IK, version: VERSION })).status, 404)
  // a non-member cannot tell enabled from disabled
  const [a, b] = await Promise.all([
    call('accept-organizer-agreement', outsider, { clubId: ZT, version: VERSION }),
    call('accept-organizer-agreement', await sessionFor('member@zatyrani-test.local'), { clubId: IK, version: VERSION }),
  ])
  assert.equal(a.status, 403)
  assert.equal(b.status, a.status)
  const { data } = await admin().from('organizer_agreements').select('id').in('club_id', [ZT, IK])
  assert.equal(data.length, 0)
})

test('F-18 agreement accepted by the owner of an enabled club, with evidence and an audit row', async () => {
  const owner = await sessionFor('owner@zatyrani-test.local')
  const r = await call('accept-organizer-agreement', owner, { clubId: ZT, version: VERSION })
  assert.equal(r.status, 200)
  const { data: rows } = await admin().from('organizer_agreements').select('*').eq('club_id', ZT)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].club_name, 'Zatyrani Test')
  assert.equal(rows[0].version, VERSION)
  assert.equal(rows[0].accepted_by, owner.profileId)
  assert.equal(rows[0].ip, '203.0.113.7')
  const { data: acts } = await admin().from('organizer_actions').select('*').eq('club_id', ZT).eq('action', 'agreement_accepted')
  assert.equal(acts.length, 1)
  assert.equal(acts[0].actor_id, owner.profileId)
  const status = await call('organizer-status', owner, { clubId: ZT })
  assert.equal(status.body.data.agreementAccepted, true)
})

test('F-18 a repeat acceptance of the current version is 200 with the same row and no second action', async () => {
  const owner = await sessionFor('owner@zatyrani-test.local')
  const r = await call('accept-organizer-agreement', owner, { clubId: ZT, version: VERSION })
  assert.equal(r.status, 200)
  assert.equal((await admin().from('organizer_agreements').select('id').eq('club_id', ZT)).data.length, 1)
  assert.equal((await admin().from('organizer_actions').select('id').eq('club_id', ZT).eq('action', 'agreement_accepted')).data.length, 1)
})

test('F-17 a member who has left gets 403 from organizer-status', async () => {
  const s = await sessionFor('member@zatyrani-test.local')
  const db = admin()
  await db.from('club_members').update({ status: 'left' }).eq('club_id', ZT).eq('user_id', s.profileId)
  try {
    assert.equal((await call('organizer-status', s, { clubId: ZT })).status, 403)
  } finally {
    await db.from('club_members').update({ status: 'active' }).eq('club_id', ZT).eq('user_id', s.profileId)
  }
})

test('F-17 waitlist join on an already enabled club: no row, no email', async () => {
  await clearMessages()
  const s = await sessionFor('admin@zatyrani-test.local')
  const r = await call('join-registration-waitlist', s, { clubId: ZT })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data, { waitlisted: false, enabled: true })
  assert.equal((await admin().from('registration_waitlist').select('club_id').eq('club_id', ZT)).data.length, 0)
  assert.equal((await messagesTo(OPERATOR)).length, 0)
})
