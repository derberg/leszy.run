// Plan 2, task 7: edits after publish (W-21…W-24, W-23b, W-46…W-48 in
// docs/registration/scenario-matrix.md). A save on a published event is
// staged in registration_pending_changes; „Opublikuj zmiany” applies it under
// the server-side locks, optionally with a change notice. LOCAL stack only;
// every event and runner address is random, so reruns pass.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'

const ZT = '00000000-0000-4000-8000-0000000000c1'
const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()
const runnerEmail = (tag) => `runner-${tag}-${rand()}@test.local`
const NO_NOTICE = { send: false }

let owner, member, stopCapture, club
before(async () => {
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  ;[owner, member] = await Promise.all(['owner@zatyrani-test.local', 'member@zatyrani-test.local'].map(sessionFor))
  const { data, error } = await db().from('clubs').select('name, owner_id').eq('id', ZT).single()
  if (error) throw error
  const { data: p } = await db().from('profiles').select('email').eq('id', data.owner_id).single()
  club = { name: data.name, ownerEmail: p.email }
})
after(async () => { if (stopCapture) await stopCapture() })

const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const MARSZ = { name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity: 30 }

const published = (competitions = [BIEG]) => createPublishedFreeEvent(owner, { competitions })

/** The competitions section as the wizard sends it: every competition, with its id. */
const items = (event, comps, over = []) => comps.map((c, i) => ({
  kind: 'individual', timed: true, isKids: false, ...c, categoryId: event.categoryIds[i], ...(over[i] ?? {}),
}))

const save = (eventId, section, value, session = owner) =>
  callFn('save-registration-section', session, { eventId, section, value })
const publishChanges = (eventId, notify = NO_NOTICE, session = owner) =>
  callFn('publish-registration-event', session, { eventId, action: 'publish_changes', notify })

async function one(table, filter) {
  let q = db().from(table).select('*')
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
  const { data, error } = await q.maybeSingle()
  if (error) throw error
  return data
}
const settingsOf = (eventId) => one('registration_settings', { event_id: eventId })
const pendingOf = (eventId) => one('registration_pending_changes', { event_id: eventId })
const competitionOf = (categoryId) => one('competitions', { category_id: categoryId })

async function consentIds(eventId) {
  const { data, error } = await db().from('event_consents').select('id').eq('event_id', eventId)
  if (error) throw error
  return data.map((c) => c.id)
}

/** n confirmed registrations through register_free itself; → their emails. */
async function registerMany(event, categoryId, n, tag = 'r') {
  const ids = await consentIds(event.eventId)
  const emails = Array.from({ length: n }, () => runnerEmail(tag))
  for (let i = 0; i < emails.length; i += 10) {
    const out = await Promise.all(emails.slice(i, i + 10).map((email) => db().rpc('register_free', {
      p_category_id: categoryId,
      p_people: [{ firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-01-01', gender: 'K', email, ageGroupLabel: 'K open' }],
      p_profile_id: null,
      p_meta: { consentIds: ids, ip: null, userAgent: 'test' },
    })))
    for (const r of out) if (r.error) throw new Error(`register_free: ${r.error.message}`)
  }
  return emails
}

// Direct RPC calls, the way the edge functions make them.
const stage = (eventId, section, value) =>
  db().rpc('stage_registration_section', { p_event_id: eventId, p_section: section, p_value: value, p_actor: owner.profileId })
const applyChanges = (eventId) =>
  db().rpc('publish_registration_changes', { p_event_id: eventId, p_actor: owner.profileId })

/** The validated snake_case competition item, as stage_registration_section receives it. */
const stagedItem = (categoryId, over = {}) => ({
  category_id: categoryId, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
  start_time: '10:00', capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true,
  gpx_upload_id: null, price: null, ...over,
})

// ---------------------------------------------------------------- W-21

test('W-21 a save on a published event is staged: live tables unchanged, changed_fields recorded; discard clears it', async () => {
  const event = await published()
  const before = await settingsOf(event.eventId)

  const r = await save(event.eventId, 'basics', { name: 'Bieg Leszego po zmianie' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.changedFields, ['basics.name'])

  const moved = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG], [{ startTime: '10:30' }]) })
  assert.equal(moved.status, 200, JSON.stringify(moved.body))

  const after = await settingsOf(event.eventId)
  assert.equal(after.name, before.name, 'registration_settings untouched')
  const { data: ev } = await db().from('events').select('name').eq('id', event.eventId).single()
  assert.equal(ev.name, before.name, 'events untouched')
  assert.equal((await competitionOf(event.categoryIds[0])).start_time, '10:00:00', 'competition untouched')

  const pending = await pendingOf(event.eventId)
  assert.deepEqual(pending.changed_fields, ['basics.name', 'competitions.items'])
  assert.equal(pending.payload.basics.name, 'Bieg Leszego po zmianie')
  assert.equal(pending.payload.competitions.items[0].start_time, '10:30')
  assert.equal(pending.updated_by, owner.profileId)

  // A second basics save merges into the staged section.
  await save(event.eventId, 'basics', { placeDetails: 'Boisko szkolne' })
  const merged = await pendingOf(event.eventId)
  assert.equal(merged.payload.basics.name, 'Bieg Leszego po zmianie')
  assert.equal(merged.payload.basics.place_details, 'Boisko szkolne')

  // Staging a value back to the live one drops it from changed_fields.
  await save(event.eventId, 'basics', { name: before.name })
  assert.deepEqual((await pendingOf(event.eventId)).changed_fields, ['basics.place_details', 'competitions.items'])

  const d = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'discard_changes' })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  assert.equal(await pendingOf(event.eventId), null)
  assert.equal((await settingsOf(event.eventId)).place_details, before.place_details)

  const { data: log } = await db().from('organizer_actions').select('action')
    .eq('event_id', event.eventId).in('action', ['changes_staged', 'changes_discarded'])
  assert.ok(log.some((a) => a.action === 'changes_discarded'))
})

test('W-21 publish_changes: notify required, nothing pending → 409, member → 403', async () => {
  const event = await published()
  assert.equal((await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'publish_changes' })).status, 400)
  const none = await publishChanges(event.eventId)
  assert.equal(none.status, 409)
  assert.equal(none.body.code, 'no_changes')
  assert.equal((await save(event.eventId, 'basics', { name: 'Inna nazwa' }, member)).status, 403)
  assert.equal((await publishChanges(event.eventId, NO_NOTICE, member)).status, 403)
  const notice = await save(event.eventId, 'basics', { name: 'Inna nazwa' })
  assert.equal(notice.status, 200)
  const noSubject = await publishChanges(event.eventId, { send: true, subject: '', body: 'x' })
  assert.equal(noSubject.status, 422, JSON.stringify(noSubject.body))
  assert.ok(noSubject.body.fields.subject)
})

test('W-21 publish_changes applies basics, office and the regulamin (version bumped) and clears the pending row', async () => {
  const event = await published()
  await save(event.eventId, 'basics', { name: 'Bieg Leszego 2027', regulaminUrl: 'https://example.org/regulamin-v2.pdf' })
  await save(event.eventId, 'office', { address: 'Hala, ul. Leśna 1', hours: [{ date: '2026-12-01', from: '08:00', to: '09:00' }] })
  const r = await publishChanges(event.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.diff.map((d) => d.field).sort(),
    ['basics.name', 'basics.regulamin_url', 'office.hours', 'office.office_address'].sort())
  assert.deepEqual(r.body.data.affected, { all: false, categoryIds: [] })

  const s = await settingsOf(event.eventId)
  assert.equal(s.name, 'Bieg Leszego 2027')
  assert.equal(s.regulamin_url, 'https://example.org/regulamin-v2.pdf')
  assert.equal(s.regulamin_version, 2)
  assert.equal(s.office_address, 'Hala, ul. Leśna 1')
  const { data: ev } = await db().from('events').select('name').eq('id', event.eventId).single()
  assert.equal(ev.name, 'Bieg Leszego 2027')
  assert.equal(await pendingOf(event.eventId), null)
  const { data: log } = await db().from('organizer_actions').select('action').eq('event_id', event.eventId).eq('action', 'changes_published')
  assert.equal(log.length, 1)
})

// ---------------------------------------------------------------- W-22

test('W-22 refused at validation: kind team → 422 „Wkrótce.”, slug and timing mode → 422', async () => {
  const event = await published()
  const team = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG], [{ kind: 'team' }]) })
  assert.equal(team.status, 422)
  assert.equal(team.body.fields.kind, 'Wkrótce.')
  const slug = await save(event.eventId, 'basics', { slug: `inny-adres-${rand()}` })
  assert.equal(slug.status, 422)
  assert.ok(slug.body.fields.slug)
  const timing = await save(event.eventId, 'timing', { timingMode: 'external' })
  assert.equal(timing.status, 422)
  assert.ok(timing.body.fields.timingMode)
  assert.equal(await pendingOf(event.eventId), null)
})

test('W-22 removing a competition after publish → 409 competition_locked, even with nobody registered', async () => {
  const event = await published([BIEG, MARSZ])
  assert.equal((await competitionOf(event.categoryIds[1])).taken, 0)
  const r = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG]) })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'competition_locked')
  // The RPC refuses it too, staged or applied.
  const { error } = await stage(event.eventId, 'competitions', { pricing_mode: 'free', items: [stagedItem(event.categoryIds[0])] })
  assert.equal(error?.message, 'competition_locked')
})

test('W-22 kind lock at apply time: taken > 0 → competition_locked (nothing applied), taken = 0 → applied', async () => {
  const event = await published()
  const cat = event.categoryIds[0]
  const team = { pricing_mode: 'free', items: [stagedItem(cat, { kind: 'team', start_time: '10:30' })] }

  let r = await stage(event.eventId, 'competitions', team)
  assert.equal(r.error, null, r.error?.message)
  await registerMany(event, cat, 1, 'kind')
  r = await applyChanges(event.eventId)
  assert.equal(r.error?.message, 'competition_locked')
  const c = await competitionOf(cat)
  assert.equal(c.kind, 'individual')
  assert.equal(c.start_time, '10:00:00', 'the whole publish rolled back')
  assert.ok(await pendingOf(event.eventId), 'pending row kept')

  const fresh = await published()
  r = await stage(fresh.eventId, 'competitions', { pricing_mode: 'free', items: [stagedItem(fresh.categoryIds[0], { kind: 'team' })] })
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(fresh.eventId)
  assert.equal(r.error, null, r.error?.message)
  assert.equal((await competitionOf(fresh.categoryIds[0])).kind, 'team')
})

test('W-22 price lock: pricing mode and price apply with taken = 0, price_locked once taken > 0', async () => {
  const event = await published()
  const cat = event.categoryIds[0]
  const fixed = (price) => ({ pricing_mode: 'fixed', items: [stagedItem(cat, { price })] })
  const amount = async () => {
    const { data } = await db().from('competition_prices').select('amount').eq('category_id', cat)
    return data.map((p) => p.amount)
  }

  let r = await stage(event.eventId, 'competitions', fixed(5000))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  assert.equal((await settingsOf(event.eventId)).pricing_mode, 'fixed')
  assert.deepEqual(await amount(), [5000])

  // Staged while nobody was registered, applied after someone was.
  r = await stage(event.eventId, 'competitions', fixed(6000))
  assert.equal(r.error, null, r.error?.message)
  await db().from('competitions').update({ taken: 1 }).eq('category_id', cat)
  r = await applyChanges(event.eventId)
  assert.equal(r.error?.message, 'price_locked')
  assert.deepEqual(await amount(), [5000])

  // Staging it now is refused straight away, and so is going back to free.
  r = await stage(event.eventId, 'competitions', fixed(7000))
  assert.equal(r.error?.message, 'price_locked')
  r = await stage(event.eventId, 'competitions', { pricing_mode: 'free', items: [stagedItem(cat)] })
  assert.equal(r.error?.message, 'price_locked')
  // The same price is no change.
  r = await stage(event.eventId, 'competitions', fixed(5000))
  assert.equal(r.error, null, r.error?.message)
})

test('W-22 slug and timing mode staged straight into the RPC → immutable', async () => {
  const event = await published()
  let r = await stage(event.eventId, 'basics', { slug: `inny-${rand()}` })
  assert.equal(r.error?.message, 'immutable')
  r = await stage(event.eventId, 'timing', { timing_mode: 'none' })
  assert.equal(r.error?.message, 'immutable')
})

// ---------------------------------------------------------------- W-23

test('W-23 a limit below the confirmed count: 409 naming the competition, nothing applied, pending kept', async () => {
  const event = await published()
  const cat = event.categoryIds[0]
  const s = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG], [{ capacity: 30, startTime: '10:30' }]) })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  await registerMany(event, cat, 31, 'cap')

  const r = await publishChanges(event.eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'capacity_below_taken')
  assert.equal(r.body.error, 'Nie można opublikować: limit „Bieg 9 km” jest mniejszy niż liczba zapisanych (31).')
  const c = await competitionOf(cat)
  assert.equal(c.capacity, 50)
  assert.equal(c.start_time, '10:00:00')
  assert.ok(await pendingOf(event.eventId))
})

test('W-23b publishing a lower limit while two registrations land: taken never above the live limit, no deadlock', async () => {
  for (let round = 0; round < 3; round++) {
    const event = await published()
    const cat = event.categoryIds[0]
    await registerMany(event, cat, 29, 'race')
    const s = await stage(event.eventId, 'competitions', { pricing_mode: 'free', items: [stagedItem(cat, { capacity: 30 })] })
    assert.equal(s.error, null, s.error?.message)

    const ids = await consentIds(event.eventId)
    const reg = () => db().rpc('register_free', {
      p_category_id: cat,
      p_people: [{ firstName: 'A', lastName: 'B', birthDate: '1990-01-01', gender: 'M', email: runnerEmail('race'), ageGroupLabel: 'M open' }],
      p_profile_id: null, p_meta: { consentIds: ids, ip: null, userAgent: 'test' },
    })
    const [pub, a, b] = await Promise.all([applyChanges(event.eventId), reg(), reg()])
    const errors = [pub, a, b].map((x) => x.error?.message).filter(Boolean)
    assert.ok(!errors.some((m) => /deadlock/i.test(m)), errors.join())

    const c = await competitionOf(cat)
    assert.ok(c.taken <= c.capacity || c.capacity === 50, `taken ${c.taken} capacity ${c.capacity}`)
    if (c.capacity === 30) {
      assert.equal(pub.error, null)
      assert.equal(c.taken, 30, 'exactly one more runner')
      assert.deepEqual(errors, ['full'])
    } else {
      assert.equal(pub.error?.message, `capacity_below_taken:${cat}`)
      assert.equal(c.taken, 31, 'both runners in, the change refused')
    }
  }
})

test('W-23 calendar row: locked name kept, admin rejection kept, kids competition adds „dzieci”', async () => {
  const event = await published()
  const { error } = await db().from('calendar_events').update({ locked_fields: ['name'], status: 'rejected' })
    .eq('source', 'leszyrun').eq('source_id', event.eventId)
  assert.equal(error, null)
  await save(event.eventId, 'basics', { name: 'Bieg Leszego zmieniony' })
  await save(event.eventId, 'competitions', {
    pricingMode: 'free',
    items: [...items(event, [BIEG]), { name: 'Bieg dzieci 400 m', kind: 'individual', discipline: 'run', distanceLabel: '400 m',
      startTime: '09:00', capacity: 40, isKids: true, timed: false, maxAge: 12 }],
  })
  const r = await publishChanges(event.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))

  const cal = await one('calendar_events', { source: 'leszyrun', source_id: event.eventId })
  assert.notEqual(cal.name, 'Bieg Leszego zmieniony')
  assert.equal(cal.status, 'rejected')
  assert.ok(cal.event_type?.includes('dzieci'), JSON.stringify(cal.event_type))
  assert.deepEqual(cal.distances, ['9 km', '400 m'])
  const { data: ev } = await db().from('events').select('name').eq('id', event.eventId).single()
  assert.equal(ev.name, 'Bieg Leszego zmieniony')
  const { data: cats } = await db().from('categories').select('name').eq('event_id', event.eventId)
  assert.deepEqual(cats.map((c) => c.name).sort(), ['Bieg 9 km', 'Bieg dzieci 400 m'])
})

// ---------------------------------------------------------------- hide (W-46…W-48)

test('W-46 hiding a competition nobody registered for: hidden_at set after publish, unhide clears it', async () => {
  const event = await published([BIEG, MARSZ])
  const marsz = event.categoryIds[1]
  let r = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{}, { hidden: true }]) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await competitionOf(marsz)).hidden_at, null, 'staged only')
  r = await publishChanges(event.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok((await competitionOf(marsz)).hidden_at)
  const cal = await one('calendar_events', { source: 'leszyrun', source_id: event.eventId })
  assert.deepEqual(cal.distances, ['9 km'])

  r = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{}, { hidden: false }]) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await publishChanges(event.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await competitionOf(marsz)).hidden_at, null)
})

test('W-47 hiding a competition with registrations → 409 competition_locked, at save and at publish', async () => {
  const event = await published([BIEG, MARSZ])
  const [bieg, marsz] = event.categoryIds
  await registerMany(event, bieg, 1, 'hide')
  const r = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{ hidden: true }]) })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'competition_locked')

  // Staged while empty, a registration lands before „Opublikuj zmiany”.
  const s = await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{}, { hidden: true }]) })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  await registerMany(event, marsz, 1, 'hide')
  const p = await publishChanges(event.eventId)
  assert.equal(p.status, 409, JSON.stringify(p.body))
  assert.equal(p.body.code, 'competition_locked')
  assert.equal((await competitionOf(marsz)).hidden_at, null)
})

test('W-48 the internal functions are not callable by the service role; the new RPCs not by anon', async () => {
  const event = await published()
  const { error } = await db().rpc('apply_registration_section', {
    p_event_id: event.eventId, p_section: 'basics', p_value: { name: 'x' }, p_allow_delete: true,
  })
  assert.match(error?.message ?? '', /permission denied/)
  const { error: e2 } = await db().rpc('registration_check_upload', { p_event_id: event.eventId, p_upload: null, p_kind: 'gpx' })
  assert.match(e2?.message ?? '', /permission denied/)

  const { createClient } = await import('@supabase/supabase-js')
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  for (const [fn, args] of [
    ['stage_registration_section', { p_event_id: event.eventId, p_section: 'basics', p_value: {}, p_actor: owner.profileId }],
    ['publish_registration_changes', { p_event_id: event.eventId, p_actor: owner.profileId }],
  ]) {
    const { error: e } = await anon.rpc(fn, args)
    assert.ok(e, `${fn} refused for anon`)
  }
})

// ---------------------------------------------------------------- W-24

test('W-24 change notice: off → no email; on → one per confirmed registrant of that competition, from the club; throttled', async () => {
  const event = await published([BIEG, MARSZ])
  const [bieg, marsz] = event.categoryIds
  const biegRunners = await registerMany(event, bieg, 2, 'notice')
  const [marszRunner] = await registerMany(event, marsz, 1, 'notice')
  const [cancelled] = await registerMany(event, bieg, 1, 'notice')
  await db().from('registrations').update({ status: 'cancelled' }).eq('email', cancelled)
  const all = [...biegRunners, marszRunner, cancelled]
  const count = async () => (await Promise.all(all.map(messagesTo))).reduce((n, m) => n + m.length, 0)
  const start = await count()

  await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{ startTime: '10:30' }]) })
  let r = await publishChanges(event.eventId, { send: false })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.affected, { all: false, categoryIds: [bieg] })
  assert.equal((await competitionOf(bieg)).start_time, '10:30:00')
  assert.equal(await count(), start, 'no email without send')

  await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{ startTime: '10:45' }]) })
  const notice = { send: true, subject: 'Zmiana godziny startu', body: 'Bieg 9 km startuje o 10:45.\nDo zobaczenia!' }
  r = await publishChanges(event.eventId, notice)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.notice.recipientCount, 2)
  for (const email of biegRunners) {
    const msgs = await messagesTo(email)
    assert.equal(msgs.length, 1, email)
    assert.equal(msgs[0].subject, notice.subject)
    assert.equal(msgs[0].text, notice.body)
    assert.ok(msgs[0].fromName.includes(club.name), msgs[0].fromName)
    assert.equal(msgs[0].replyTo, club.ownerEmail)
    assert.equal(msgs[0].html, undefined, 'plain text only')
  }
  assert.equal((await messagesTo(marszRunner)).length, 0, 'other competition not told')
  assert.equal((await messagesTo(cancelled)).length, 0, 'cancelled registration not told')

  const msg = await one('organizer_messages', { event_id: event.eventId })
  assert.equal(msg.recipient_count, 2)
  assert.equal(msg.subject, notice.subject)
  assert.equal(msg.body, notice.body)
  assert.equal(msg.sent_by, owner.profileId)
  const { data: log } = await db().from('organizer_actions').select('action').eq('event_id', event.eventId)
    .in('action', ['changes_published', 'change_notice_sent'])
  assert.deepEqual(log.map((a) => a.action).sort(), ['change_notice_sent', 'changes_published', 'changes_published'])

  // A second notice inside the window: 429, nothing applied, nothing sent.
  await save(event.eventId, 'competitions', { pricingMode: 'free', items: items(event, [BIEG, MARSZ], [{ startTime: '11:00' }]) })
  const before = await count()
  r = await publishChanges(event.eventId, notice)
  assert.equal(r.status, 429, JSON.stringify(r.body))
  assert.equal(await count(), before)
  assert.equal((await competitionOf(bieg)).start_time, '10:45:00')
  assert.ok(await pendingOf(event.eventId))
  // Without the notice the same changes publish.
  r = await publishChanges(event.eventId, { send: false })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await competitionOf(bieg)).start_time, '11:00:00')
})

test('W-24 a date change tells every confirmed registrant of the event', async () => {
  const event = await published([BIEG, MARSZ])
  const runners = [...await registerMany(event, event.categoryIds[0], 1, 'date'), ...await registerMany(event, event.categoryIds[1], 1, 'date')]
  const s = await settingsOf(event.eventId)
  const next = new Date(Date.parse(s.event_date) - 86400000).toISOString().slice(0, 10)
  const r0 = await save(event.eventId, 'basics', { eventDate: next })
  assert.equal(r0.status, 200, JSON.stringify(r0.body))
  const r = await publishChanges(event.eventId, { send: true, subject: 'Nowa data', body: `Zawody odbędą się ${next}.` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.affected.all, true)
  assert.equal(r.body.data.notice.recipientCount, 2)
  for (const email of runners) assert.equal((await messagesTo(email)).length, 1, email)
})
