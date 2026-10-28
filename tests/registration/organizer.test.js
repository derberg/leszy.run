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

test('GDPR export: the owner gets their agreement, actions, payout change and waitlist request', async () => {
  const owner = await sessionFor('owner@zatyrani-test.local')
  const db = admin()
  const { error } = await db.from('club_payout_history').insert({
    club_id: ZT, club_name: 'Zatyrani Test', changed_by: owner.profileId,
    old: null, new: { iban: 'PL61109010140000071219812874', nip: '5260250995' },
  })
  assert.equal(error, null)
  const { error: wErr } = await db.from('registration_waitlist').upsert({ club_id: IK, requested_by: owner.profileId })
  assert.equal(wErr, null)
  try {
    const res = await fetch(`${localEnv().functionsUrl}/export-my-data`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie },
    })
    assert.equal(res.status, 200)
    const { organizer } = await res.json()
    assert.equal(organizer.agreements_accepted.length, 1)
    assert.equal(organizer.agreements_accepted[0].version, VERSION)
    assert.equal(organizer.agreements_accepted[0].club_name, 'Zatyrani Test')
    assert.ok(organizer.actions.some((a) => a.action === 'agreement_accepted'))
    assert.equal(organizer.payout_changes.length, 1)
    assert.equal(organizer.payout_changes[0].new.iban, 'PL61109010140000071219812874')
    assert.equal(organizer.waitlist_requests.length, 1)

    // Someone else's export holds none of it.
    const other = await sessionFor('member@zatyrani-test.local')
    const r2 = await fetch(`${localEnv().functionsUrl}/export-my-data`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: other.cookie },
    })
    const o2 = (await r2.json()).organizer
    assert.deepEqual([o2.agreements_accepted, o2.actions, o2.payout_changes, o2.waitlist_requests], [[], [], [], []])
  } finally {
    await db.from('club_payout_history').delete().eq('changed_by', owner.profileId)
    await db.from('registration_waitlist').delete().eq('club_id', IK).eq('requested_by', owner.profileId)
  }
})

test('GDPR erasure: organizer records stay, the deleted person\'s IP and browser are cleared', async () => {
  const email = `erase-${Date.now()}@zatyrani-test.local`
  const s = await sessionFor(email)
  const db = admin()
  const sha = async (t) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, '0')).join('')
  const { data: ag } = await db.from('organizer_agreements').insert({
    club_id: ZT, club_name: 'Zatyrani Test', version: VERSION, accepted_by: s.profileId, ip: '198.51.100.9', user_agent: 'UA-erase',
  }).select('id').single()
  const { data: ac } = await db.from('organizer_actions').insert({
    actor_id: s.profileId, club_id: ZT, action: 'test_erase', ip: '198.51.100.9', user_agent: 'UA-erase',
  }).select('id').single()
  const { data: hi } = await db.from('club_payout_history').insert({
    club_id: ZT, club_name: 'Zatyrani Test', changed_by: s.profileId, new: { nip: '5260250995' },
  }).select('id').single()
  await db.from('registration_waitlist').upsert({ club_id: IK, requested_by: s.profileId })
  await db.from('auth_codes').insert({
    email, code_hash: await sha('123456'), purpose: 'delete_account',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  try {
    const r = await call('delete-my-account', s, { action: 'confirm', code: '123456' })
    assert.equal(r.status, 200)
    const { data: a } = await db.from('organizer_agreements').select('accepted_by, ip, user_agent, version').eq('id', ag.id).single()
    assert.deepEqual(a, { accepted_by: s.profileId, ip: null, user_agent: null, version: VERSION })
    const { data: b } = await db.from('organizer_actions').select('actor_id, ip, user_agent').eq('id', ac.id).single()
    assert.deepEqual(b, { actor_id: s.profileId, ip: null, user_agent: null })
    assert.equal((await db.from('club_payout_history').select('id').eq('id', hi.id)).data.length, 1)
    assert.equal((await db.from('registration_waitlist').select('club_id').eq('club_id', IK).eq('requested_by', s.profileId)).data.length, 1)
  } finally {
    await db.from('organizer_agreements').delete().eq('id', ag.id)
    await db.from('organizer_actions').delete().eq('id', ac.id)
    await db.from('club_payout_history').delete().eq('id', hi.id)
    await db.from('registration_waitlist').delete().eq('club_id', IK).eq('requested_by', s.profileId)
  }
})
