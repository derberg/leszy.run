// Plan 4, task 3: consent requests for an added adult (G-20…G-26, G-26b in
// docs/registration/scenario-matrix.md). A request is a single-use hashed token:
// issue_consent_request, rotate_consent_request, accept_consent_request,
// mark_consent_office and claim_consent_reminders. LOCAL stack only; every
// event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { consentIds, db, one, profileFor, rows, rpc, runnerEmail, setSettings } from './helpers/orders.js'
import { BIEG, adult, isDeadlock, registerGroup } from './helpers/groups.js'
import { newToken } from '../../supabase/functions/_shared/registration/tokens.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString()

/** A free event with one buyer and one added adult (confirmed, awaiting) → { event, regId, email, buyerProfile }. */
async function awaitingAdult(event = null, over = {}) {
  const ev = event ?? await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  const cat = ev.categoryIds[0]
  const email = runnerEmail('adult')
  const buyerEmail = runnerEmail('self')
  const buyerProfile = await profileFor(buyerEmail)
  const r = await registerGroup(ev, [
    adult(cat, 'self', buyerEmail),
    adult(cat, 'adult', email, { firstName: 'Piotr', gender: 'M', ageGroupLabel: 'M open', ...over }),
  ], { profileId: buyerProfile })
  assert.equal(r.error, null, r.error?.message)
  const regId = r.data.registrations.find((x) => x.role === 'adult').id
  return { event: ev, regId, email, buyerProfile, participantId: r.data.registrations.find((x) => x.role === 'adult').participantId }
}

const issue = (regId, hash) => rpc('issue_consent_request', { p_registration_id: regId, p_token_hash: hash })
const rotate = (regId, hash) => rpc('rotate_consent_request', { p_registration_id: regId, p_token_hash: hash })
const office = (regId, actor) => rpc('mark_consent_office', { p_registration_id: regId, p_actor: actor })
const claim = (limit = 50) => rpc('claim_consent_reminders', { p_limit: limit })

async function acceptMeta(eventId, over = {}) {
  return { consentIds: await consentIds(eventId), ip: '198.51.100.7', userAgent: 'consent-test', ...over }
}
async function accept(ctx, hash, { edits = null, meta, profileId } = {}) {
  return rpc('accept_consent_request', {
    p_token_hash: hash,
    p_profile_id: profileId ?? await profileFor(ctx.email),
    p_edits: edits,
    p_meta: meta ?? await acceptMeta(ctx.event.eventId),
  })
}

async function issued(ctx) {
  const t = await newToken()
  const r = await issue(ctx.regId, t.hash)
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data, true)
  return t
}

const requestOf = (regId) => one('consent_requests', { registration_id: regId })
const regOf = (regId) => one('registrations', { id: regId })
const acceptancesOf = (regId) => rows('consent_acceptances', { registration_id: regId })
const kinds = (list) => list.map((a) => a.consent_kind).sort()

// ---------------------------------------------------------------- G-20

test('G-20 issue twice → true, then false; one row, expiring at Warsaw midnight after the race day', async () => {
  const ctx = await awaitingAdult()
  const a = await newToken()
  const b = await newToken()
  assert.deepEqual(await issue(ctx.regId, a.hash).then((r) => [r.error, r.data]), [null, true])
  assert.deepEqual(await issue(ctx.regId, b.hash).then((r) => [r.error, r.data]), [null, false])
  const list = await rows('consent_requests', { registration_id: ctx.regId })
  assert.equal(list.length, 1)
  assert.equal(list[0].token_hash, a.hash)
  assert.equal(list[0].used_at, null)
  assert.equal(list[0].auto_reminded_at, null)
  assert.equal(list[0].last_reminded_at, null)
  // event_date + 1 at 00:00 Europe/Warsaw.
  const day = new Date(Date.UTC(...ctx.event.eventDate.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) + 86400_000)
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(list[0].expires_at))
  assert.equal(local, `${day.toISOString().slice(0, 10)}, 00:00`)
})

test('G-20 issue is refused (false) for a registration that is not confirmed and awaiting', async () => {
  const ctx = await awaitingAdult()
  const ev = ctx.event
  const self = (await rows('registrations', { event_id: ev.eventId })).find((r) => r.consent_state === 'accepted')
  assert.equal((await issue(self.id, (await newToken()).hash)).data, false, 'the buyer accepted already')
  await db().from('registrations').update({ status: 'cancelled' }).eq('id', ctx.regId)
  assert.equal((await issue(ctx.regId, (await newToken()).hash)).data, false, 'cancelled')
  assert.equal((await rows('consent_requests', { registration_id: ctx.regId })).length, 0)
  const bad = await issue(self.id, 'not-a-hash')
  assert.ok(bad.error, 'a malformed hash is refused')
})

// ---------------------------------------------------------------- G-21

test('G-21 accept → accepted, 4 self acceptances, profile_id set; the same token again → invalid', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  const profileId = await profileFor(ctx.email)

  const r = await accept(ctx, t.hash, { profileId })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.status, 'accepted')
  assert.equal(r.data.registrationId, ctx.regId)

  const reg = await regOf(ctx.regId)
  assert.equal(reg.consent_state, 'accepted')
  assert.equal(reg.profile_id, profileId)
  const acc = await acceptancesOf(ctx.regId)
  assert.deepEqual(kinds(acc), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  assert.ok(acc.every((a) => a.accepted_as === 'self' && a.accepted_by_profile_id === profileId))
  assert.ok(acc.every((a) => a.ip === '198.51.100.7' && a.user_agent === 'consent-test'))
  const settings = await one('registration_settings', { event_id: ctx.event.eventId })
  assert.equal(acc.find((a) => a.consent_kind === 'regulamin').regulamin_version, settings.regulamin_version)
  assert.ok((await requestOf(ctx.regId)).used_at, 'the token is spent')

  const again = await accept(ctx, t.hash, { profileId })
  assert.equal(again.error, null, again.error?.message)
  assert.equal(again.data.status, 'invalid')
  assert.equal((await acceptancesOf(ctx.regId)).length, 4)
})

test('G-21 a consentIds list missing image → consents_changed, nothing written, the token still valid', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  const { data: image } = await db().from('event_consents').select('id')
    .eq('event_id', ctx.event.eventId).eq('kind', 'image').single()
  const ids = (await consentIds(ctx.event.eventId)).filter((id) => id !== image.id)
  const r = await accept(ctx, t.hash, { meta: await acceptMeta(ctx.event.eventId, { consentIds: ids }) })
  assert.equal(r.error?.message, 'consents_changed')
  assert.equal((await regOf(ctx.regId)).consent_state, 'awaiting')
  assert.equal((await acceptancesOf(ctx.regId)).length, 0)
  assert.equal((await requestOf(ctx.regId)).used_at, null)
  assert.equal((await accept(ctx, t.hash)).data.status, 'accepted')
})

test('G-21 an unknown hash → invalid; a profile whose address is not the registration\'s is refused', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  assert.equal((await accept(ctx, (await newToken()).hash)).data.status, 'invalid')
  const stranger = await profileFor(runnerEmail('stranger'))
  const r = await accept(ctx, t.hash, { profileId: stranger })
  assert.equal(r.error?.message, 'profile_mismatch')
  assert.equal((await requestOf(ctx.regId)).used_at, null)
  assert.equal((await regOf(ctx.regId)).consent_state, 'awaiting')
})

test('G-21 a consentIds entry that is not a uuid, or no list at all → consents_changed (never 22P02), the token still valid', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  const ids = await consentIds(ctx.event.eventId)
  for (const bad of [[...ids, 'nie-uuid'], [...ids.slice(1), 42], [...ids.slice(1), null], 'abc', { a: 1 }]) {
    const r = await accept(ctx, t.hash, { meta: await acceptMeta(ctx.event.eventId, { consentIds: bad }) })
    assert.equal(r.error?.message, 'consents_changed', JSON.stringify(bad))
    assert.notEqual(r.error?.code, '22P02')
  }
  assert.equal((await requestOf(ctx.regId)).used_at, null)
  assert.equal((await accept(ctx, t.hash)).data.status, 'accepted')
})

/**
 * Runs `work` inside a transaction that holds the event's settings row FOR UPDATE (as
 * publish_registration_changes does), starts `call` while it is held, and commits after
 * 800 ms. → the call's result.
 */
async function duringPublish(eventId, work, call) {
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    let pending
    await sql.begin(async (tx) => {
      await tx`select 1 from public.registration_settings where event_id = ${eventId} for update`
      await work(tx)
      // A PostgREST builder is lazy: await it here so the request leaves while the lock is held.
      pending = (async () => await call())()
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    return await pending
  } finally {
    await sql.end()
  }
}

test('G-21 a publish landing mid-accept: a consent removed → consents_changed (never 23503); a regulamin bump → the new version recorded', async () => {
  const ctx = await awaitingAdult()
  const { data: custom, error } = await db().from('event_consents')
    .insert({ event_id: ctx.event.eventId, kind: 'custom', text: 'Zgoda dodatkowa', sort_order: 9 }).select('id').single()
  assert.ifError(error)
  const t = await issued(ctx)
  const meta = await acceptMeta(ctx.event.eventId)
  assert.ok(meta.consentIds.includes(custom.id))
  const before = (await one('registration_settings', { event_id: ctx.event.eventId })).regulamin_version

  const r = await duringPublish(ctx.event.eventId, async (tx) => {
    await tx`delete from public.event_consents where id = ${custom.id}`
    await tx`update public.registration_settings set regulamin_version = regulamin_version + 1 where event_id = ${ctx.event.eventId}`
  }, () => accept(ctx, t.hash, { meta }))
  assert.equal(r.error?.message, 'consents_changed', JSON.stringify(r.error))
  assert.notEqual(r.error?.code, '23503')
  assert.equal((await requestOf(ctx.regId)).used_at, null)
  assert.equal((await acceptancesOf(ctx.regId)).length, 0)

  // The page re-reads the consents; meanwhile another publish bumps the regulamin only.
  const fresh = await acceptMeta(ctx.event.eventId)
  const ok = await duringPublish(ctx.event.eventId, async (tx) => {
    await tx`update public.registration_settings set regulamin_version = regulamin_version + 1 where event_id = ${ctx.event.eventId}`
  }, () => accept(ctx, t.hash, { meta: fresh }))
  assert.equal(ok.error, null, ok.error?.message)
  assert.equal(ok.data.status, 'accepted')
  const reg = (await acceptancesOf(ctx.regId)).find((a) => a.consent_kind === 'regulamin')
  assert.equal(reg.regulamin_version, before + 2, 'the version current when the accept committed')
})

test('G-25 mark_consent_office during a regulamin bump records the new version', async () => {
  const ctx = await awaitingAdult()
  await issued(ctx)
  const actor = await profileFor('owner@zatyrani-test.local')
  const before = (await one('registration_settings', { event_id: ctx.event.eventId })).regulamin_version
  const r = await duringPublish(ctx.event.eventId, async (tx) => {
    await tx`update public.registration_settings set regulamin_version = regulamin_version + 1 where event_id = ${ctx.event.eventId}`
  }, () => office(ctx.regId, actor))
  assert.deepEqual([r.error, r.data], [null, true])
  const reg = (await acceptancesOf(ctx.regId)).find((a) => a.consent_kind === 'regulamin')
  assert.equal(reg.regulamin_version, before + 1)
})

// ---------------------------------------------------------------- G-22

test('G-22 rotate → the old hash invalid, the new one accepted; rotate after use → false', async () => {
  const ctx = await awaitingAdult()
  const old = await issued(ctx)
  const fresh = await newToken()
  const r = await rotate(ctx.regId, fresh.hash)
  assert.deepEqual([r.error, r.data], [null, true])
  const req = await requestOf(ctx.regId)
  assert.equal(req.token_hash, fresh.hash)
  assert.ok(req.last_reminded_at, 'last_reminded_at stamped')

  assert.equal((await accept(ctx, old.hash)).data.status, 'invalid')
  assert.equal((await accept(ctx, fresh.hash)).data.status, 'accepted')
  assert.equal((await rotate(ctx.regId, (await newToken()).hash)).data, false)
})

test('G-22 rotate of a registration that is no longer confirmed, or has no request → false', async () => {
  const ctx = await awaitingAdult()
  assert.equal((await rotate(ctx.regId, (await newToken()).hash)).data, false, 'nothing issued')
  await issued(ctx)
  await db().from('registrations').update({ status: 'cancelled' }).eq('id', ctx.regId)
  assert.equal((await rotate(ctx.regId, (await newToken()).hash)).data, false, 'cancelled')
})

// ---------------------------------------------------------------- G-23 / G-24

test('G-23 the registration is cancelled → gone, nothing written, the token still unused', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  await db().from('registrations').update({ status: 'cancelled' }).eq('id', ctx.regId)
  const r = await accept(ctx, t.hash)
  assert.equal(r.error?.message, 'gone')
  const reg = await regOf(ctx.regId)
  assert.equal(reg.consent_state, 'awaiting')
  assert.equal(reg.profile_id, null)
  assert.equal((await acceptancesOf(ctx.regId)).length, 0)
  assert.equal((await requestOf(ctx.regId)).used_at, null)
})

test('G-24 past expires_at → expired; nothing written', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  await db().from('consent_requests').update({ expires_at: hoursFromNow(-1) }).eq('registration_id', ctx.regId)
  const r = await accept(ctx, t.hash)
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.status, 'expired')
  assert.equal((await regOf(ctx.regId)).consent_state, 'awaiting')
  assert.equal((await rotate(ctx.regId, (await newToken()).hash)).data, false, 'an expired request is not rotated')
})

// ---------------------------------------------------------------- mark_consent_office

test('G-25 mark_consent_office → office, office acceptances by the actor, the request spent; a second call → false', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  const actor = await profileFor('owner@zatyrani-test.local')
  const r = await office(ctx.regId, actor)
  assert.deepEqual([r.error, r.data], [null, true])
  assert.equal((await regOf(ctx.regId)).consent_state, 'office')
  const acc = await acceptancesOf(ctx.regId)
  assert.deepEqual(kinds(acc), ['data_info', 'image', 'regulamin'], 'the event consents signed on paper, not the service regulamin')
  assert.ok(acc.every((a) => a.accepted_as === 'office' && a.accepted_by_profile_id === actor && a.ip === null))
  assert.ok((await requestOf(ctx.regId)).used_at)
  assert.equal((await office(ctx.regId, actor)).data, false)
  assert.equal((await accept(ctx, t.hash)).data.status, 'invalid')
})

// ---------------------------------------------------------------- G-25 concurrency

test('G-25 5 parallel accepts of one token → exactly one success', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  const profileId = await profileFor(ctx.email)
  const meta = await acceptMeta(ctx.event.eventId)
  const rs = await Promise.all(Array.from({ length: 5 }, () => accept(ctx, t.hash, { profileId, meta })))
  assert.deepEqual(rs.filter((r) => r.error).map((r) => r.error.message), [])
  assert.equal(rs.filter((r) => r.data.status === 'accepted').length, 1, JSON.stringify(rs.map((r) => r.data)))
  assert.equal(rs.filter((r) => r.data.status === 'invalid').length, 4)
  assert.equal((await acceptancesOf(ctx.regId)).length, 4)
})

test('G-25 accept racing mark_consent_office, 100 rounds → exactly one wins, one set of acceptances, no deadlock', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(500)] })
  const actor = await profileFor('owner@zatyrani-test.local')
  const meta = await acceptMeta(event.eventId)
  for (let i = 0; i < 100; i++) {
    const ctx = await awaitingAdult(event)
    const t = await issued(ctx)
    const profileId = await profileFor(ctx.email)
    const [a, o] = await Promise.all([accept(ctx, t.hash, { profileId, meta }), office(ctx.regId, actor)])
    for (const r of [a, o]) assert.ok(!isDeadlock(r), `round ${i}: ${r.error?.message}`)
    assert.equal(a.error, null, `round ${i}: ${a.error?.message}`)
    assert.equal(o.error, null, `round ${i}: ${o.error?.message}`)
    const accepted = a.data.status === 'accepted'
    assert.ok(accepted !== (o.data === true), `round ${i}: exactly one wins (${a.data.status}, ${o.data})`)
    const reg = await regOf(ctx.regId)
    assert.equal(reg.consent_state, accepted ? 'accepted' : 'office', `round ${i}`)
    const acc = await acceptancesOf(ctx.regId)
    assert.ok(acc.length > 0 && acc.every((x) => x.accepted_as === (accepted ? 'self' : 'office')), `round ${i}: one set`)
    assert.equal(acc.length, accepted ? 4 : 3, `round ${i}`)
  }
})

test('G-25 accept racing rotate, 30 rounds → the old token wins and rotate is false, or only the new hash is valid', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(500)] })
  const meta = await acceptMeta(event.eventId)
  for (let i = 0; i < 30; i++) {
    const ctx = await awaitingAdult(event)
    const old = await issued(ctx)
    const fresh = await newToken()
    const profileId = await profileFor(ctx.email)
    const [a, r] = await Promise.all([accept(ctx, old.hash, { profileId, meta }), rotate(ctx.regId, fresh.hash)])
    assert.equal(a.error, null, `round ${i}: ${a.error?.message}`)
    assert.equal(r.error, null, `round ${i}: ${r.error?.message}`)
    if (a.data.status === 'accepted') {
      assert.equal(r.data, false, `round ${i}: the old token won, rotate is false`)
      assert.equal((await requestOf(ctx.regId)).token_hash, old.hash)
    } else {
      assert.equal(a.data.status, 'invalid', `round ${i}`)
      assert.equal(r.data, true, `round ${i}`)
      assert.equal((await accept(ctx, old.hash, { profileId, meta })).data.status, 'invalid')
      assert.equal((await accept(ctx, fresh.hash, { profileId, meta })).data.status, 'accepted')
    }
  }
})

// ---------------------------------------------------------------- G-26 edits

test('G-26 allowed edits before closes_at apply to the registration and the participant; age group recomputed', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  const cat = event.categoryIds[0]
  await db().from('age_groups').insert([
    { category_id: cat, gender: 'M', label: 'M30–39', min_age: 30, max_age: 39 },
    { category_id: cat, gender: 'K', label: 'K30–39', min_age: 30, max_age: 39 },
  ])
  const ctx = await awaitingAdult(event)
  const t = await issued(ctx)
  const edits = {
    firstName: 'Paweł', lastName: 'Borowy', phone: '+48600700800', city: 'Gliwice', club: 'KB Leśne',
    iceName: 'Anna Borowa', icePhone: '+48600900100', birthDate: '1992-03-04', gender: 'K',
  }
  const r = await accept(ctx, t.hash, { edits })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.status, 'accepted')
  const reg = await regOf(ctx.regId)
  assert.deepEqual(
    [reg.first_name, reg.last_name, reg.phone, reg.city, reg.club, reg.ice_name, reg.ice_phone, reg.birth_date, reg.gender],
    ['Paweł', 'Borowy', '+48600700800', 'Gliwice', 'KB Leśne', 'Anna Borowa', '+48600900100', '1992-03-04', 'K'])
  assert.equal(reg.email, ctx.email, 'the address never changes')
  assert.equal(reg.age_group_label, 'K30–39')
  const part = await one('participants', { id: ctx.participantId })
  assert.deepEqual([part.first_name, part.last_name, part.phone, part.club, part.birth_date, part.gender],
    ['Paweł', 'Borowy', '+48600700800', 'KB Leśne', '1992-03-04', 'K'])
})

test('G-26 an edit making the person a minor or ineligible, or touching the email → edit_invalid, nothing written', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  await db().from('competitions').update({ max_age: 60 }).eq('category_id', event.categoryIds[0])
  const ctx = await awaitingAdult(event)
  const t = await issued(ctx)
  const minorBirth = `${new Date().getUTCFullYear() - 10}-01-01`
  for (const edits of [
    { birthDate: minorBirth },
    { birthDate: '1940-01-01' },
    { birthDate: '2999-01-01' },
    { birthDate: 'nie-data' },
    { gender: 'X' },
    { email: runnerEmail('new') },
    { favouriteColour: 'green' },
    { firstName: '   ' },
    { phone: '' },
  ]) {
    const r = await accept(ctx, t.hash, { edits })
    assert.equal(r.error?.message, 'edit_invalid', JSON.stringify(edits))
  }
  const reg = await regOf(ctx.regId)
  assert.equal(reg.consent_state, 'awaiting')
  assert.equal(reg.birth_date, '1990-01-01')
  assert.equal((await requestOf(ctx.regId)).used_at, null)
  assert.equal((await accept(ctx, t.hash)).data.status, 'accepted')
})

test('G-26 nationality and switched-off fields follow the event form', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  await setSettings(event.eventId, { form_fields: { city: 'off', club: 'optional', ice: 'optional', nationality: 'optional' } })
  const ctx = await awaitingAdult(event)
  const t = await issued(ctx)
  assert.equal((await accept(ctx, t.hash, { edits: { city: 'Gliwice' } })).error?.message, 'edit_invalid', 'city is off')
  assert.equal((await accept(ctx, t.hash, { edits: { nationality: 'polska' } })).error?.message, 'edit_invalid')
  const r = await accept(ctx, t.hash, { edits: { nationality: 'de' } })
  assert.equal(r.error, null, r.error?.message)
  assert.equal((await regOf(ctx.regId)).nationality, 'DE')
})

test('G-26 after closes_at: an edit → edits_closed and nothing written; no edits (or unchanged values) → accepted', async () => {
  const ctx = await awaitingAdult()
  const t = await issued(ctx)
  await setSettings(ctx.event.eventId, { closes_at: hoursFromNow(-1) })
  const r = await accept(ctx, t.hash, { edits: { phone: '+48600000001' } })
  assert.equal(r.error?.message, 'edits_closed')
  assert.equal((await requestOf(ctx.regId)).used_at, null)
  assert.equal((await regOf(ctx.regId)).phone, '+48500100200')
  const same = await accept(ctx, t.hash, { edits: { phone: '+48500100200', firstName: 'Piotr' } })
  assert.equal(same.error, null, same.error?.message)
  assert.equal(same.data.status, 'accepted')
  assert.equal((await one('participants', { id: ctx.participantId })).phone, '+48500100200')
})

// ---------------------------------------------------------------- G-26b reminders

/** An issued request whose event closes in `closesInH` hours and which was e-mailed `sentAgoH` hours ago. */
async function reminderCase({ closesInH = 71, sentAgoH = 48 } = {}) {
  const ctx = await awaitingAdult()
  await issued(ctx)
  await setSettings(ctx.event.eventId, { closes_at: hoursFromNow(closesInH) })
  await db().from('consent_requests').update({ sent_at: hoursFromNow(-sentAgoH) }).eq('registration_id', ctx.regId)
  return ctx
}
const claimed = async (limit) => {
  const r = await claim(limit)
  assert.equal(r.error, null, r.error?.message)
  return r.data
}

test('G-26b claim_consent_reminders: 71 h before close and sent 2 days ago → claimed once; a second call → nothing', async () => {
  const ctx = await reminderCase()
  const first = await claimed(500)
  assert.ok(first.includes(ctx.regId), JSON.stringify(first))
  assert.ok((await requestOf(ctx.regId)).auto_reminded_at)
  const second = await claimed(500)
  assert.ok(!second.includes(ctx.regId))
  // A manual reminder later does not make it eligible again: at most once, ever.
  await db().from('consent_requests').update({ last_reminded_at: hoursFromNow(-30) }).eq('registration_id', ctx.regId)
  assert.ok(!(await claimed(500)).includes(ctx.regId))
})

test('G-26b never claimed: sent 1 h ago, reminded 1 h ago, already used, cancelled, more than 72 h before close, after close, expired', async () => {
  const recent = await reminderCase({ sentAgoH: 1 })
  const reminded = await reminderCase()
  await db().from('consent_requests').update({ last_reminded_at: hoursFromNow(-1) }).eq('registration_id', reminded.regId)
  const used = await reminderCase()
  await db().from('consent_requests').update({ used_at: hoursFromNow(-1) }).eq('registration_id', used.regId)
  const cancelled = await reminderCase()
  await db().from('registrations').update({ status: 'cancelled' }).eq('id', cancelled.regId)
  const early = await reminderCase({ closesInH: 73 })
  const closed = await reminderCase({ closesInH: -1 })
  const expired = await reminderCase()
  await db().from('consent_requests').update({ expires_at: hoursFromNow(-1) }).eq('registration_id', expired.regId)
  const got = await claimed(500)
  for (const [name, c] of Object.entries({ recent, reminded, used, cancelled, early, closed, expired })) {
    assert.ok(!got.includes(c.regId), `${name} must not be claimed`)
    assert.equal((await requestOf(c.regId)).auto_reminded_at, null, name)
  }
})

test('G-26b two parallel claims → each eligible request claimed by exactly one', async () => {
  const cases = []
  for (let i = 0; i < 6; i++) cases.push(await reminderCase())
  const ids = cases.map((c) => c.regId)
  const [a, b] = await Promise.all([claimed(500), claimed(500)])
  for (const id of ids) {
    assert.equal(Number(a.includes(id)) + Number(b.includes(id)), 1, `${id} claimed exactly once`)
  }
})

test('G-26b p_limit bounds one call', async () => {
  const cases = []
  for (let i = 0; i < 3; i++) cases.push(await reminderCase())
  const first = await claimed(1)
  assert.equal(first.length, 1)
  const rest = await claimed(500)
  const mine = cases.map((c) => c.regId)
  assert.equal([...first, ...rest].filter((id) => mine.includes(id)).length, 3)
})

// ---------------------------------------------------------------- schema and grants

test('G-20 consent_requests: RLS on, no client grants, unique registration and hash; the RPCs service_role only', async () => {
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const [t] = await sql`select relrowsecurity from pg_class where oid = 'public.consent_requests'::regclass`
    assert.equal(t.relrowsecurity, true)
    const grants = await sql`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'consent_requests' and grantee in ('anon', 'authenticated')`
    assert.deepEqual([...grants], [], 'no table privilege for anon or authenticated')
    const [fk] = await sql`
      select confdeltype, confrelid::regclass::text as target from pg_constraint
       where conrelid = 'public.consent_requests'::regclass and contype = 'f'`
    assert.equal(fk.target, 'registrations')
    assert.equal(fk.confdeltype, 'r', 'on delete restrict')
    const uniques = await sql`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'consent_requests'`
    assert.ok(uniques.some((i) => /UNIQUE/.test(i.indexdef) && /\(registration_id\)/.test(i.indexdef)))
    assert.ok(uniques.some((i) => /UNIQUE/.test(i.indexdef) && /\(token_hash\)/.test(i.indexdef)))

    const fns = await sql`
      select p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authd,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('issue_consent_request', 'rotate_consent_request',
             'accept_consent_request', 'mark_consent_office', 'claim_consent_reminders')
       order by 1`
    assert.equal(fns.length, 5, fns.map((f) => f.proname).join())
    for (const f of fns) {
      assert.equal(f.prosecdef, true, `${f.proname} security definer`)
      assert.deepEqual(f.proconfig, ['search_path=""'], `${f.proname} search_path`)
      assert.equal(f.anon, false, `${f.proname} anon`)
      assert.equal(f.authd, false, `${f.proname} authenticated`)
      assert.equal(f.svc, true, `${f.proname} service_role`)
    }
    const helpers = await sql`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authd
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'registration_age_on'`
    assert.equal(helpers.length, 1)
    assert.equal(helpers[0].anon, false)
    assert.equal(helpers[0].authd, false)
  } finally {
    await sql.end()
  }
})
