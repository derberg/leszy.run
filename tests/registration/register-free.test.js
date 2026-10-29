// Plan 2, task 9: free registration (W-29…W-35 in docs/registration/scenario-matrix.md).
// LOCAL stack only. Every event and runner address is random, so reruns on a
// stack holding earlier data still pass.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { lastCodeFor, messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, makeClub } from './helpers/registrationFixtures.js'
import { startScratchHost } from './helpers/hostPull.js'
import { RETIRED_EMAIL_MESSAGE } from '../../supabase/functions/_shared/deletedEmails.js'

const ZT = '00000000-0000-4000-8000-0000000000c1'
const FULL = 'Brak wolnych miejsc w tej konkurencji.'
const CLOSED = 'Zapisy są zamknięte.'
const NOT_OPEN = 'Zapisy jeszcze się nie rozpoczęły.'
const DUPLICATE = 'Ten adres e-mail jest już zapisany na te zawody.'
const CONSENTS = 'Zaznacz wymagane zgody.'

const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()
const runnerEmail = (tag) => `runner-${tag}-${rand()}@test.local`

let owner, clubAdmin, member, outsider, stopCapture
before(async () => {
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  ;[owner, clubAdmin, member, outsider] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local', 'owner@inny-klub.local',
  ].map(sessionFor))
})
after(async () => { if (stopCapture) await stopCapture() })
beforeEach(async () => { await resetThrottle() })

/**
 * POST register-free; keeps the Set-Cookie header (callFn drops headers). The client address is
 * `RUNNER_IP` for every call, which the acceptance rows are checked against; the per-IP throttle
 * (20 an hour) is reset before each test, so the file's calls never add up to it.
 */
const RUNNER_IP = '203.0.113.9'
async function register(body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/register-free`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-forwarded-for': RUNNER_IP,
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') }
}

async function requestCode(email) {
  const res = await fetch(`${localEnv().functionsUrl}/auth-request-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  })
  assert.equal(res.status, 200, await res.text())
  let code = null
  for (let i = 0; i < 20 && !code; i++) {
    code = await lastCodeFor(email)
    if (!code) await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(code, 'login email captured')
  return code
}

async function consentIds(eventId) {
  const { data, error } = await db().from('event_consents').select('id').eq('event_id', eventId)
  if (error) throw error
  return data.map((c) => c.id)
}

const person = (email, over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', ...over,
})

async function body(event, email, over = {}) {
  return {
    categoryId: event.categoryIds[0], person: person(email), acceptedConsentIds: await consentIds(event.eventId),
    serviceRegulamin: true, ...over,
  }
}

const publishedEvent = (opts = {}) => createPublishedFreeEvent(owner, opts)

async function taken(categoryId) {
  const { data, error } = await db().from('competitions').select('taken').eq('category_id', categoryId).single()
  if (error) throw error
  return data.taken
}

async function registrationsOf(categoryId) {
  const { data, error } = await db().from('registrations').select('*').eq('category_id', categoryId)
  if (error) throw error
  return data
}

async function participantsOf(categoryId) {
  const { data, error } = await db().from('participants').select('*').eq('category_id', categoryId)
  if (error) throw error
  return data
}

const setSettings = async (eventId, values) => {
  const { error } = await db().from('registration_settings').update(values).eq('event_id', eventId)
  assert.ifError(error)
}

/** Merges keys into registration_settings.form_fields, as a published event holds them. */
async function setFormFields(eventId, fields) {
  const { data, error } = await db().from('registration_settings').select('form_fields').eq('event_id', eventId).single()
  assert.ifError(error)
  await setSettings(eventId, { form_fields: { ...data.form_fields, ...fields } })
}

async function waitForMail(email, n = 1) {
  for (let i = 0; i < 20; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await new Promise((r) => setTimeout(r, 250))
  }
  return messagesTo(email)
}

// ---------------------------------------------------------------- W-29 happy path

test('W-29 a new address with its captured code → 201, cookie, confirmed registration, participant, email', async () => {
  const event = await publishedEvent({ name: `Bieg Leszego ${rand()}` })
  const email = runnerEmail('ok')
  const code = await requestCode(email)

  const r = await register({ ...(await body(event, email)), code })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.match(r.setCookie ?? '', /^leszy_session=[0-9a-f]{64};/)
  assert.deepEqual(r.body.data.registrations.map((x) => ({ ...x, id: typeof x.id })), [
    { id: 'string', competition: 'Bieg 9 km', ageGroupLabel: 'K open', startTime: '10:00' },
  ])

  const { data: profile } = await db().from('profiles').select('id, username').eq('email', email).single()
  const token = r.setCookie.match(/^leszy_session=([0-9a-f]{64})/)[1]
  const { data: sessionRow } = await db().from('auth_sessions').select('user_id, email').eq('id', token).single()
  assert.deepEqual(sessionRow, { user_id: profile.id, email })
  assert.equal(profile.username, null, 'no username during registration')

  const regs = await registrationsOf(event.categoryIds[0])
  assert.equal(regs.length, 1)
  const [reg] = regs
  assert.equal(reg.id, r.body.data.registrations[0].id)
  assert.equal(reg.event_id, event.eventId)
  assert.equal(reg.status, 'confirmed')
  assert.equal(reg.consent_state, 'accepted')
  assert.equal(reg.price, 0)
  assert.equal(reg.list_price, 0)
  assert.equal(reg.profile_id, profile.id)
  assert.equal(reg.email, email)
  assert.equal(reg.phone, '600100200')
  assert.equal(reg.age_group_label, 'K open')
  assert.equal(await taken(event.categoryIds[0]), 1)

  const { data: acc } = await db().from('consent_acceptances').select('*').eq('registration_id', reg.id)
  assert.equal(acc.length, 4)
  assert.deepEqual(acc.map((a) => a.consent_kind).sort(), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  for (const a of acc) {
    assert.equal(a.accepted_as, 'self')
    assert.equal(a.accepted_by_profile_id, profile.id)
    assert.equal(a.ip, '203.0.113.9')
    assert.equal(a.consent_id === null, a.consent_kind === 'service_regulamin')
  }
  assert.equal(acc.find((a) => a.consent_kind === 'regulamin').regulamin_version, 1)

  const parts = await participantsOf(event.categoryIds[0])
  assert.equal(parts.length, 1)
  const [p] = parts
  assert.equal(p.registration_id, reg.id)
  assert.equal(reg.participant_id, p.id)
  assert.equal(p.bib_number, null)
  assert.equal(p.event_id, event.eventId)
  assert.deepEqual(
    { first: p.first_name, last: p.last_name, email: p.email, gender: p.gender, birth: p.birth_date, phone: p.phone, removed: p.removed_at },
    { first: 'Ola', last: 'Leśna', email, gender: 'K', birth: '1990-05-01', phone: '600100200', removed: null },
  )

  const mails = (await waitForMail(email, 2)).filter((m) => m.subject.startsWith('Jesteś na liście'))
  assert.equal(mails.length, 1)
  const [mail] = mails
  const { data: ev } = await db().from('registration_settings').select('name').eq('event_id', event.eventId).single()
  assert.equal(mail.subject, `Jesteś na liście — ${ev.name}`)
  assert.ok(mail.text.includes('Bieg 9 km'), mail.text)
  assert.ok(mail.text.includes('K open'), mail.text)
  assert.ok(mail.text.includes('10:00'), mail.text)
  assert.ok(mail.html.includes('Bieg 9 km'))
  assert.doesNotMatch(mail.text, /numer startowy|\bnr\b/i)
})

test('W-29 my-event-registrations returns the session’s confirmed registrations; list-event-registrations for owner and admin only', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('mine')
  const runner = await sessionFor(email)
  const r = await register(await body(event, email), runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.setCookie, null, 'the session already belongs to the person: no new cookie')
  const { slug } = await db().from('registration_settings').select('slug').eq('event_id', event.eventId).single().then((x) => x.data)

  const mine = await callFn('my-event-registrations', runner, { slug })
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.deepEqual(mine.body.data.map((x) => ({ id: x.id, competition: x.competition, status: x.status })), [
    { id: r.body.data.registrations[0].id, competition: 'Bieg 9 km', status: 'confirmed' },
  ])
  assert.deepEqual((await callFn('my-event-registrations', owner, { slug })).body.data, [])
  assert.equal((await callFn('my-event-registrations', null, { slug })).status, 401)
  assert.equal((await callFn('my-event-registrations', runner, { slug: 'nie-ma-takiego-wydarzenia' })).status, 404)

  // Runner personal data is for the club's owner and admins (ruling P2-R20):
  // a member is answered like an outsider (P2-R9).
  assert.equal((await callFn('list-event-registrations', member, { eventId: event.eventId })).status, 404)
  assert.equal((await callFn('list-event-registrations', clubAdmin, { eventId: event.eventId })).status, 200)
  const list = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.equal(list.body.data.length, 1)
  const [row] = list.body.data
  assert.deepEqual({ ...row, createdAt: typeof row.createdAt }, {
    id: r.body.data.registrations[0].id, name: 'Ola Leśna', competition: 'Bieg 9 km', ageGroupLabel: 'K open',
    status: 'confirmed', createdAt: 'string', paymentStatus: 'free', expiresAt: null,
  })
  const { data: caps } = await admin().from('competitions').select('capacity, taken').eq('event_id', event.eventId)
  assert.deepEqual(list.body.counts, { paid: 0, awaiting: 0, free: 1, placesLeft: caps.reduce((n, c) => n + c.capacity - c.taken, 0) })
  assert.equal((await callFn('list-event-registrations', outsider, { eventId: event.eventId })).status, 404)
  assert.equal((await callFn('list-event-registrations', null, { eventId: event.eventId })).status, 401)
})

test('W-29 an invalid person → 400 with field errors; a minor registering themself → 400 invalid_group; two adults are a group (G-33)', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('bad')
  const runner = await sessionFor(email)
  const bad = await register({ ...(await body(event, email)), person: person(email, { gender: 'X', firstName: '' }) }, runner)
  assert.equal(bad.status, 400)
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['firstName', 'gender'])

  // Plan 4 (G-33): a minor is registered by a parent or guardian, never by themself.
  const minor = await register({ ...(await body(event, email)), person: person(email, { birthDate: '2012-01-01' }) }, runner)
  assert.equal(minor.status, 400)
  assert.deepEqual(minor.body, { error: 'Osobę niepełnoletnią zapisuje rodzic lub opiekun.', code: 'invalid_group' })
  assert.equal(await taken(event.categoryIds[0]), 0)
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 0)

  // Plan 4 (G-33): two adults in one body are a valid group.
  const two = await register({ ...(await body(event, email)), person: undefined, people: [person(email), person(runnerEmail('b'))] }, runner)
  assert.equal(two.status, 201, JSON.stringify(two.body))
  assert.equal(await taken(event.categoryIds[0]), 2)
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 2)
})

// ---------------------------------------------------------------- W-30 last place

test('W-30 capacity 1, two runners at once → one 201, one 409 „Brak wolnych miejsc…”, taken 1', async () => {
  const event = await publishedEvent({ competitions: [{ name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 1 }] })
  const emails = [runnerEmail('a'), runnerEmail('b')]
  const sessions = await Promise.all(emails.map(sessionFor))
  const bodies = await Promise.all(emails.map((e) => body(event, e)))
  const results = await Promise.all(bodies.map((b, i) => register(b, sessions[i])))
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409], JSON.stringify(results.map((x) => x.body)))
  const refused = results.find((x) => x.status === 409)
  assert.equal(refused.body.error, FULL)
  assert.equal(refused.body.code, 'full')
  assert.equal(await taken(event.categoryIds[0]), 1)
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 1)
  assert.equal((await participantsOf(event.categoryIds[0])).length, 1)
})

test('W-30 the RPC itself: eight concurrent claims for two places → two registrations, taken never above capacity', async () => {
  const event = await publishedEvent({ competitions: [{ name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 2 }] })
  const ids = await consentIds(event.eventId)
  const calls = Array.from({ length: 8 }, () => db().rpc('register_free', {
    p_category_id: event.categoryIds[0],
    p_people: [{ firstName: 'A', lastName: 'B', birthDate: '1990-01-01', gender: 'M', email: runnerEmail('rpc'), ageGroupLabel: 'M open' }],
    p_profile_id: null,
    p_meta: { consentIds: ids, ip: null, userAgent: 'test' },
  }))
  const out = await Promise.all(calls)
  assert.equal(out.filter((x) => !x.error).length, 2, JSON.stringify(out.map((x) => x.error?.message)))
  assert.deepEqual([...new Set(out.filter((x) => x.error).map((x) => x.error.message))], ['full'])
  assert.equal(await taken(event.categoryIds[0]), 2)
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 2)
})

test('W-30 register_free is not callable by anon or authenticated', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await anon.rpc('register_free', {
    p_category_id: crypto.randomUUID(), p_people: [], p_profile_id: null, p_meta: {},
  })
  assert.ok(error, 'anon is refused')
  assert.match(error.message, /permission denied/)
})

// ---------------------------------------------------------------- W-31 double submit

test('W-31 the same request twice at once → one 201, one 409 duplicate, one participant', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('dbl')
  const runner = await sessionFor(email)
  const b = await body(event, email)
  const results = await Promise.all([register(b, runner), register(b, runner)])
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409], JSON.stringify(results.map((x) => x.body)))
  const dup = results.find((x) => x.status === 409)
  assert.equal(dup.body.error, DUPLICATE)
  assert.equal(dup.body.code, 'duplicate')
  assert.equal(await taken(event.categoryIds[0]), 1)
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 1)
  assert.equal((await participantsOf(event.categoryIds[0])).length, 1)

  // A later resubmit, and the same address (other case) in another competition of the event.
  const again = await register(b, runner)
  assert.equal(again.status, 409)
  assert.equal(again.body.error, DUPLICATE)
})

test('W-31 one person, one start: the same address in a second competition of the event → 409 duplicate', async () => {
  const event = await publishedEvent({ competitions: [
    { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 },
    { name: 'Nordic walking 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:15', capacity: 50 },
  ] })
  const email = runnerEmail('two')
  const runner = await sessionFor(email)
  assert.equal((await register(await body(event, email), runner)).status, 201)
  const second = await register({ ...(await body(event, email)), categoryId: event.categoryIds[1], person: person(email.toUpperCase()) }, runner)
  assert.equal(second.status, 409, JSON.stringify(second.body))
  assert.equal(second.body.error, DUPLICATE)
  assert.equal(await taken(event.categoryIds[1]), 0)
})

test('W-31 the same request with a code, twice at once → exactly one registration', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('dblcode')
  const code = await requestCode(email)
  const b = { ...(await body(event, email)), code }
  const results = await Promise.all([register(b), register(b)])
  assert.equal(results.filter((x) => x.status === 201).length, 1, JSON.stringify(results.map((x) => [x.status, x.body])))
  const other = results.find((x) => x.status !== 201)
  assert.ok(other.status >= 400 && other.status < 500, JSON.stringify(other.body))
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 1)
  assert.equal(await taken(event.categoryIds[0]), 1)
})

// ---------------------------------------------------------------- W-32 refusals

test('W-32 a draft event → 404; a disabled club → 404; an unknown category → 404', async () => {
  const email = runnerEmail('ref')
  const runner = await sessionFor(email)

  const created = await callFn('create-registration-event', owner, { clubId: ZT, name: `Szkic ${rand()}` })
  assert.equal(created.status, 201)
  const { eventId } = created.body.data
  const saved = await callFn('save-registration-section', owner, { eventId, section: 'competitions', value: {
    pricingMode: 'free', items: [{ name: 'Bieg 9 km', kind: 'individual', discipline: 'run', capacity: 50, timed: true }],
  } })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const draft = await register(await body({ eventId, categoryIds: saved.body.data.categoryIds }, email), runner)
  assert.equal(draft.status, 404, JSON.stringify(draft.body))

  const clubSlug = `reg-free-${rand()}`
  const club = await makeClub({ slug: clubSlug })
  const offEvent = await createPublishedFreeEvent(await sessionFor(club.ownerEmail), { clubSlug })
  const { error } = await db().from('clubs').update({ registration_enabled: false }).eq('id', club.clubId)
  assert.ifError(error)
  const off = await register(await body(offEvent, email), runner)
  assert.equal(off.status, 404, JSON.stringify(off.body))

  const unknown = await register({ ...(await body(offEvent, email)), categoryId: crypto.randomUUID() }, runner)
  assert.equal(unknown.status, 404)
  assert.equal((await register({ ...(await body(offEvent, email)), categoryId: 'nie-uuid' }, runner)).status, 404)
})

test('W-32 a paid event → 409 not_free; nothing claimed', async () => {
  const event = await publishedEvent()
  await setSettings(event.eventId, { pricing_mode: 'fixed' })
  const email = runnerEmail('paid')
  const r = await register(await body(event, email), await sessionFor(email))
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'not_free')
  assert.equal(await taken(event.categoryIds[0]), 0)
})

test('W-32 a hidden competition → 409 „Zapisy są zamknięte.”', async () => {
  const event = await publishedEvent()
  const { error } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', event.categoryIds[0])
  assert.ifError(error)
  const email = runnerEmail('hid')
  const r = await register(await body(event, email), await sessionFor(email))
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.error, CLOSED)
  assert.equal(r.body.code, 'closed')
  assert.equal(await taken(event.categoryIds[0]), 0)
})

test('W-32 the RPC refuses a hidden competition and a closed event on its own', async () => {
  const event = await publishedEvent()
  const ids = await consentIds(event.eventId)
  const call = (consentIdsSent = ids) => db().rpc('register_free', {
    p_category_id: event.categoryIds[0],
    p_people: [{ firstName: 'A', lastName: 'B', birthDate: '1990-01-01', gender: 'M', email: runnerEmail('rpc'), ageGroupLabel: 'M open' }],
    p_profile_id: null, p_meta: { consentIds: consentIdsSent },
  })
  await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', event.categoryIds[0])
  assert.equal((await call()).error?.message, 'closed')
  await db().from('competitions').update({ hidden_at: null }).eq('category_id', event.categoryIds[0])
  await setSettings(event.eventId, { state: 'closed' })
  assert.equal((await call()).error?.message, 'closed')
  await setSettings(event.eventId, { state: 'published', pricing_mode: 'fixed' })
  assert.equal((await call()).error?.message, 'not_free')
  await setSettings(event.eventId, { pricing_mode: 'free' })
  assert.equal((await call(ids.slice(1))).error?.message, 'consents_changed', 'a consent list that no longer matches is refused')
  assert.equal(await taken(event.categoryIds[0]), 0)
  assert.equal((await call()).error, null)
  assert.equal(await taken(event.categoryIds[0]), 1)
})

// ---------------------------------------------------------------- W-33 window

test('W-33 one minute before closes_at → 201; at closes_at → 409 „Zapisy są zamknięte.”; before opens_at → 409', async () => {
  const event = await publishedEvent()
  const now = Date.now()
  await setSettings(event.eventId, { opens_at: new Date(now - 86400000).toISOString(), closes_at: new Date(now + 60000).toISOString() })
  const first = runnerEmail('last-minute')
  const ok = await register(await body(event, first), await sessionFor(first))
  assert.equal(ok.status, 201, JSON.stringify(ok.body))

  await setSettings(event.eventId, { closes_at: new Date().toISOString() })
  const late = runnerEmail('late')
  const closed = await register(await body(event, late), await sessionFor(late))
  assert.equal(closed.status, 409, JSON.stringify(closed.body))
  assert.equal(closed.body.error, CLOSED)

  const later = Date.now()
  await setSettings(event.eventId, { opens_at: new Date(later + 3600000).toISOString(), closes_at: new Date(later + 86400000).toISOString() })
  const early = await register(await body(event, late), await sessionFor(late))
  assert.equal(early.status, 409, JSON.stringify(early.body))
  assert.equal(early.body.error, NOT_OPEN)
  assert.equal(early.body.code, 'not_open')
  assert.equal(await taken(event.categoryIds[0]), 1)
})

// ---------------------------------------------------------------- W-34 another address

test('W-34 logged in as A, registering B: code required; with B\'s code the registration and the new cookie are B\'s', async () => {
  const event = await publishedEvent()
  const emailA = runnerEmail('a')
  const emailB = runnerEmail('b')
  const a = await sessionFor(emailA)
  const { data: profileABefore } = await db().from('profiles').select('*').eq('id', a.profileId).single()

  const noCode = await register(await body(event, emailB), a)
  assert.equal(noCode.status, 401, JSON.stringify(noCode.body))
  assert.equal(noCode.body.code, 'code_required')
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 0)

  const code = await requestCode(emailB)
  const wrong = await register({ ...(await body(event, emailB)), code: code === '000000' ? '111111' : '000000' }, a)
  assert.equal(wrong.status, 401, JSON.stringify(wrong.body))

  const r = await register({ ...(await body(event, emailB)), code }, a)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { data: profileB } = await db().from('profiles').select('id').eq('email', emailB).single()
  const token = r.setCookie.match(/^leszy_session=([0-9a-f]{64})/)[1]
  const { data: sessionRow } = await db().from('auth_sessions').select('user_id, email').eq('id', token).single()
  assert.deepEqual(sessionRow, { user_id: profileB.id, email: emailB })

  const [reg] = await registrationsOf(event.categoryIds[0])
  assert.equal(reg.profile_id, profileB.id)
  assert.equal(reg.email, emailB)
  const { data: acc } = await db().from('consent_acceptances').select('accepted_by_profile_id').eq('registration_id', reg.id)
  assert.ok(acc.every((x) => x.accepted_by_profile_id === profileB.id))
  const { data: profileAAfter } = await db().from('profiles').select('*').eq('id', a.profileId).single()
  assert.deepEqual(profileAAfter, profileABefore)
})

// ---------------------------------------------------------------- W-35 retired, consents, host pull

test('W-35 a retired address → 403 with the exact Plan 1 message', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('retired')
  const hash = crypto.createHash('sha256').update(email).digest('hex')
  const { error } = await db().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })
  assert.ifError(error)
  const r = await register({ ...(await body(event, email)), code: '123456' })
  assert.equal(r.status, 403, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' })
  assert.equal(r.body.error, 'Ten adres e-mail należał do usuniętego konta LESZY.RUN i nie może zostać użyty ponownie. Podaj inny adres albo napisz do nas: kontakt@leszy.run.')
  assert.equal((await registrationsOf(event.categoryIds[0])).length, 0)
})

test('W-35 a missing consent → 400 „Zaznacz wymagane zgody.”, nothing claimed', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('consent')
  const runner = await sessionFor(email)
  const ids = await consentIds(event.eventId)
  for (const over of [
    { serviceRegulamin: false },
    { serviceRegulamin: undefined },
    { acceptedConsentIds: ids.slice(1) },
    { acceptedConsentIds: [...ids, crypto.randomUUID()] },
    { acceptedConsentIds: undefined },
  ]) {
    const r = await register({ ...(await body(event, email)), ...over }, runner)
    assert.equal(r.status, 400, JSON.stringify([over, r.body]))
    assert.equal(r.body.error, CONSENTS)
  }
  assert.equal(await taken(event.categoryIds[0]), 0)
})

test('W-35 the timing host pulls the new participant', async () => {
  const host = await startScratchHost()
  try {
    const event = await publishedEvent()
    const email = runnerEmail('host')
    const r = await register(await body(event, email), await sessionFor(email))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    await host.pull()
    const rows = await host.sql`select first_name, last_name, email, bib_number, registration_id, removed_at, category_id
                                  from participants where event_id = ${event.eventId}`
    assert.deepEqual(rows.map((x) => ({ ...x })), [{
      first_name: 'Ola', last_name: 'Leśna', email, bib_number: null,
      registration_id: r.body.data.registrations[0].id, removed_at: null, category_id: event.categoryIds[0],
    }])
  } finally {
    await host.stop()
  }
})

// ---------------------------------------------------------------- W-41, W-42 GDPR

/** Registers a runner by email with a captured code; → { event, email, reg, session }. */
async function registeredRunner(tag, formFields = null, personOver = {}) {
  const event = await publishedEvent()
  if (formFields) await setFormFields(event.eventId, formFields)
  const email = runnerEmail(tag)
  const code = await requestCode(email)
  const r = await register({ ...(await body(event, email)), person: person(email, personOver), code })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const token = r.setCookie.match(/^leszy_session=([0-9a-f]{64})/)[1]
  return { event, email, regId: r.body.data.registrations[0].id, session: { cookie: `leszy_session=${token}` } }
}

test('W-41 export-my-data holds the registration, its four acceptances and the nationality', async () => {
  const { email, regId, session } = await registeredRunner('export', { nationality: 'optional' }, { nationality: 'DE' })
  const res = await callFn('export-my-data', session, {})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const regs = res.body.registrations
  assert.equal(regs.length, 1)
  const [reg] = regs
  assert.equal(reg.id, regId)
  assert.equal(reg.email, email)
  assert.equal(reg.phone, '600100200')
  assert.equal(reg.first_name, 'Ola')
  assert.equal(reg.birth_date, '1990-05-01')
  assert.equal(reg.status, 'confirmed')
  assert.equal(reg.consent_acceptances.length, 4)
  assert.deepEqual(reg.consent_acceptances.map((a) => a.consent_kind).sort(), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  assert.equal(reg.nationality, 'DE', 'nationality is exported (P2-R31)')
  assert.equal(reg.consent_acceptances[0].ip, '203.0.113.9')
})

test('W-42 delete-my-account anonymises the registration, keeps the slot, retires the address', async () => {
  const { event, email, regId, session } = await registeredRunner('erase', { nationality: 'required' }, { nationality: 'CZ' })
  assert.equal((await db().from('registrations').select('nationality').eq('id', regId).single()).data.nationality, 'CZ')
  assert.equal(await taken(event.categoryIds[0]), 1)
  const sha = async (t) => crypto.createHash('sha256').update(t).digest('hex')
  const { error: codeErr } = await db().from('auth_codes').insert({
    email, code_hash: await sha('123456'), purpose: 'delete_account',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(codeErr)

  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))

  const { data: reg } = await db().from('registrations').select('*').eq('id', regId).single()
  assert.equal(reg.first_name, 'Usunięte konto')
  assert.equal(reg.last_name, 'Usunięte konto')
  for (const col of ['email', 'phone', 'birth_date', 'ice_name', 'ice_phone', 'city', 'club', 'nationality', 'guardian_name', 'guardian_email']) {
    assert.equal(reg[col], null, col)
  }
  assert.equal(reg.status, 'confirmed')
  assert.equal(reg.price, 0)
  assert.equal(await taken(event.categoryIds[0]), 1, 'the slot stays taken')

  const { data: acc } = await db().from('consent_acceptances').select('ip, user_agent').eq('registration_id', regId)
  assert.equal(acc.length, 4)
  for (const a of acc) assert.deepEqual(a, { ip: null, user_agent: null })

  const [p] = await participantsOf(event.categoryIds[0])
  assert.equal(p.email, null)
  assert.equal(p.phone, null)
  assert.equal(p.first_name, 'Uczestnik')
  assert.notEqual(p.deleted_at, null)

  const again = await register({ ...(await body(event, email)), person: person(email, { nationality: 'CZ' }), code: '123456' })
  assert.equal(again.status, 403, JSON.stringify(again.body))
  assert.equal(again.body.code, 'email_retired')
})

/** Makes A the guardian of B's registration, directly in SQL (register_free does not write guardian_* yet). */
async function makeGuardian(a, b) {
  const { data: pa } = await db().from('profiles').select('id').eq('email', a.email).single()
  const u1 = await db().from('registrations')
    .update({ guardian_profile_id: pa.id, guardian_email: a.email, guardian_name: 'Tata Leśny' }).eq('id', b.regId)
  assert.ifError(u1.error)
  const u2 = await db().from('consent_acceptances')
    .update({ accepted_by_profile_id: pa.id, accepted_as: 'guardian' }).eq('registration_id', b.regId)
  assert.ifError(u2.error)
  return pa.id
}

test('W-41 export-my-data returns the registrations made as guardian, with their acceptances', async () => {
  const a = await registeredRunner('guardian-export-a')
  const b = await registeredRunner('guardian-export-b')
  await makeGuardian(a, b)
  const res = await callFn('export-my-data', a.session, {})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const g = res.body.registrations_as_guardian
  assert.equal(g.length, 1)
  assert.equal(g[0].id, b.regId)
  assert.equal(g[0].guardian_name, 'Tata Leśny')
  assert.equal(g[0].guardian_email, a.email)
  assert.equal(g[0].consent_acceptances.length, 4)
  assert.equal(g[0].consent_acceptances[0].accepted_as, 'guardian')
})

test('W-42 deleting the guardian clears the guardian fields and device traces, and leaves the child\'s row alone', async () => {
  const a = await registeredRunner('guardian-erase-a')
  const b = await registeredRunner('guardian-erase-b')
  await makeGuardian(a, b)
  const sha = async (t) => crypto.createHash('sha256').update(t).digest('hex')
  const { error: codeErr } = await db().from('auth_codes').insert({
    email: a.email, code_hash: await sha('123456'), purpose: 'delete_account',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(codeErr)
  const r = await callFn('delete-my-account', a.session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))

  const { data: reg } = await db().from('registrations').select('*').eq('id', b.regId).single()
  assert.equal(reg.guardian_profile_id, null)
  assert.equal(reg.guardian_email, null)
  assert.equal(reg.guardian_name, 'Usunięte konto')
  assert.equal(reg.first_name, 'Ola')
  assert.equal(reg.email, b.email)
  assert.equal(reg.phone, '600100200')
  const { data: acc } = await db().from('consent_acceptances').select('ip, user_agent').eq('registration_id', b.regId)
  assert.equal(acc.length, 4)
  for (const x of acc) assert.deepEqual(x, { ip: null, user_agent: null })
})

// ---------------------------------------------------------------- W-64…W-66 form rulings (P2-R31…R33)

test('W-64 nationality: stored as the ISO code when asked; a code off the list → 400; required and missing → 400', async () => {
  const event = await publishedEvent()
  await setFormFields(event.eventId, { nationality: 'required' })
  const email = runnerEmail('nat')
  const runner = await sessionFor(email)

  for (const [nationality, message] of [['XX', 'Wybierz kraj z listy.'], ['Polska', 'Wybierz kraj z listy.'], [undefined, 'Wybierz narodowość.'], ['', 'Wybierz narodowość.']]) {
    const r = await register({ ...(await body(event, email)), person: person(email, { nationality }) }, runner)
    assert.equal(r.status, 400, JSON.stringify([nationality, r.body]))
    assert.equal(r.body.code, 'invalid_person')
    assert.equal(r.body.fields.nationality, message)
  }
  assert.equal(await taken(event.categoryIds[0]), 0)

  const ok = await register({ ...(await body(event, email)), person: person(email, { nationality: 'ua' }) }, runner)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  const [reg] = await registrationsOf(event.categoryIds[0])
  assert.equal(reg.nationality, 'UA')
  const [p] = await participantsOf(event.categoryIds[0])
  assert.equal('nationality' in p, false, 'participants has no nationality column: the timing host never gets it')
})

test('W-64 nationality off (the default): a sent value is not stored', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('nat-off')
  const r = await register({ ...(await body(event, email)), person: person(email, { nationality: 'DE' }) }, await sessionFor(email))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const [reg] = await registrationsOf(event.categoryIds[0])
  assert.equal(reg.nationality, null)
})

test('W-64 the column refuses anything but two upper-case letters', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('nat-col')
  const r = await register(await body(event, email), await sessionFor(email))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const id = r.body.data.registrations[0].id
  for (const bad of ['pl', 'POL', 'P']) {
    const u = await db().from('registrations').update({ nationality: bad }).eq('id', id)
    assert.equal(u.error?.code, '23514', bad)
  }
})

test('W-65 a missing phone → 400 even when the stored mode says optional or off (P2-R32)', async () => {
  const event = await publishedEvent()
  const email = runnerEmail('phone')
  const runner = await sessionFor(email)
  for (const mode of ['optional', 'off']) {
    await setFormFields(event.eventId, { phone: mode })
    const r = await register({ ...(await body(event, email)), person: person(email, { phone: '' }) }, runner)
    assert.equal(r.status, 400, JSON.stringify([mode, r.body]))
    assert.equal(r.body.code, 'invalid_person')
    assert.equal(r.body.fields.phone, 'Podaj numer telefonu.')
  }
  assert.equal(await taken(event.categoryIds[0]), 0)
  const ok = await register(await body(event, email), runner)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  assert.equal((await registrationsOf(event.categoryIds[0]))[0].phone, '600100200', 'stored even with a stored off mode')
})

test('W-66 every published event carries the image acceptance; registering without it is refused (P2-R33)', async () => {
  const event = await publishedEvent()
  const { data: image } = await db().from('event_consents').select('id, sort_order').eq('event_id', event.eventId).eq('kind', 'image')
  assert.equal(image.length, 1)

  const email = runnerEmail('image')
  const runner = await sessionFor(email)
  const all = await consentIds(event.eventId)
  const r = await register({ ...(await body(event, email)), acceptedConsentIds: all.filter((id) => id !== image[0].id) }, runner)
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.error, CONSENTS)

  // The RPC itself refuses a consent list without it.
  const rpc = await db().rpc('register_free', {
    p_category_id: event.categoryIds[0],
    p_people: [{ firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' }],
    p_profile_id: null,
    p_meta: { consentIds: all.filter((id) => id !== image[0].id) },
  })
  assert.equal(rpc.error?.message, 'consents_changed')
  assert.equal(await taken(event.categoryIds[0]), 0)

  const ok = await register(await body(event, email), runner)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  const { data: acc } = await db().from('consent_acceptances').select('consent_id, consent_kind')
    .eq('registration_id', ok.body.data.registrations[0].id).eq('consent_kind', 'image')
  assert.deepEqual(acc, [{ consent_id: image[0].id, consent_kind: 'image' }])
})
