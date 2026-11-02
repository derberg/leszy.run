// The guardian consent („Zgoda opiekuna · dzieci”, event_consents.minors_only): shown, required and
// accepted only for a registration with a child in it. Scenarios G-77…G-83 in
// docs/registration/scenario-matrix.md. Migration 20261105090000_consent_minors_only.sql; the JS
// rule is requiredConsents() in _shared/registration/consents.js. LOCAL stack only; every event and
// address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EDGE_PROXY, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { consentIds, db, one, profileFor, rows, rpc, runnerEmail } from './helpers/orders.js'
import { BIEG, DZIECI, adult, groupMeta, minor, registerGroup } from './helpers/groups.js'
import { accept as acceptTransfer, enableTransfers, freeEntry, inviteOk } from './helpers/transfers.js'
import { newToken } from '../../supabase/functions/_shared/registration/tokens.js'

const GUARDIAN = 'Jako opiekun zgadzam się na udział dziecka w zawodach.'

let owner
before(async () => {
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

/** A published free event (adults' run, kids' run) with the guardian consent live → { event, guardianId }. */
async function withGuardianConsent(existing = null) {
  const event = existing ?? await createPublishedFreeEvent(owner, { competitions: [BIEG(), DZIECI()] })
  let r = await callFn('save-registration-section', owner, {
    eventId: event.eventId, section: 'form', value: { consents: [{ text: GUARDIAN, minorsOnly: true }] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'publish_changes', notify: { send: false } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const g = await one('event_consents', { event_id: event.eventId, kind: 'custom' })
  assert.equal(g.minors_only, true)
  return { event, guardianId: g.id }
}

/** Every consent id of the event but the guardian one. */
const adultIds = async (eventId, guardianId) => (await consentIds(eventId)).filter((id) => id !== guardianId)
const acceptancesOf = (registrationId) => rows('consent_acceptances', { registration_id: registrationId })

// ---------------------------------------------------------------- G-77 register_free / create_order

test('G-77 adults only: the request without the guardian consent registers; with it → consents_changed', async () => {
  const { event, guardianId } = await withGuardianConsent()
  const [c9] = event.categoryIds
  const me = runnerEmail('self')
  const profileId = await profileFor(me)
  const people = [adult(c9, 'self', me), adult(c9, 'adult', runnerEmail('adult'), { firstName: 'Jan', gender: 'M', ageGroupLabel: 'M open' })]

  const withIt = await registerGroup(event, people, { profileId, meta: await groupMeta(event.eventId) })
  assert.equal(withIt.error?.message, 'consents_changed', 'an adult was never shown it')

  const r = await registerGroup(event, people, {
    profileId, meta: await groupMeta(event.eventId, { consentIds: await adultIds(event.eventId, guardianId) }),
  })
  assert.equal(r.error, null, r.error?.message)
  const self = r.data.registrations.find((x) => x.role === 'self')
  const acc = await acceptancesOf(self.id)
  assert.equal(acc.some((a) => a.consent_id === guardianId), false, 'no guardian acceptance for the runner themself')
  assert.deepEqual(acc.map((a) => a.consent_kind).sort(), ['data_info', 'image', 'regulamin', 'service_regulamin'])
})

test('G-78 with a child: the guardian consent is required, and accepted for the child only (as guardian)', async () => {
  const { event, guardianId } = await withGuardianConsent()
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('self')
  const profileId = await profileFor(me)
  const people = [adult(c9, 'self', me), minor(kids)]

  const without = await registerGroup(event, people, {
    profileId, meta: await groupMeta(event.eventId, { consentIds: await adultIds(event.eventId, guardianId) }),
  })
  assert.equal(without.error?.message, 'consents_changed')

  const r = await registerGroup(event, people, { profileId })
  assert.equal(r.error, null, r.error?.message)
  const self = r.data.registrations.find((x) => x.role === 'self')
  const child = r.data.registrations.find((x) => x.role === 'minor')
  assert.equal((await acceptancesOf(self.id)).some((a) => a.consent_id === guardianId), false, 'the parent\'s own entry')
  const childAcc = await acceptancesOf(child.id)
  const g = childAcc.filter((a) => a.consent_id === guardianId)
  assert.equal(g.length, 1)
  assert.equal(g[0].accepted_as, 'guardian')
  assert.equal(g[0].accepted_by_profile_id, profileId)
})

test('G-78 an added adult gets no acceptance at all, the guardian consent included', async () => {
  const { event } = await withGuardianConsent()
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('self')
  const r = await registerGroup(event, [
    adult(c9, 'self', me), adult(c9, 'adult', runnerEmail('adult'), { firstName: 'Jan', gender: 'M', ageGroupLabel: 'M open' }), minor(kids),
  ], { profileId: await profileFor(me) })
  assert.equal(r.error, null, r.error?.message)
  const added = r.data.registrations.find((x) => x.role === 'adult')
  assert.equal((await acceptancesOf(added.id)).length, 0)
})

// ---------------------------------------------------------------- G-79 the added adult's consent page and the office

async function awaitingAdult() {
  const ctx = await withGuardianConsent()
  const [c9, kids] = ctx.event.categoryIds
  const me = runnerEmail('self')
  const email = runnerEmail('adult')
  const r = await registerGroup(ctx.event, [
    adult(c9, 'self', me), adult(c9, 'adult', email, { firstName: 'Piotr', gender: 'M', ageGroupLabel: 'M open' }), minor(kids),
  ], { profileId: await profileFor(me) })
  assert.equal(r.error, null, r.error?.message)
  return { ...ctx, email, regId: r.data.registrations.find((x) => x.role === 'adult').id }
}

test('G-79 accept_consent_request: the adult\'s set leaves the guardian consent out, and it is never accepted', async () => {
  const ctx = await awaitingAdult()
  const t = await newToken()
  assert.equal((await rpc('issue_consent_request', { p_registration_id: ctx.regId, p_token_hash: t.hash })).data, true)
  const profileId = await profileFor(ctx.email)
  const meta = (ids) => ({ consentIds: ids, ip: '198.51.100.7', userAgent: 'consent-test' })

  const withIt = await rpc('accept_consent_request', {
    p_token_hash: t.hash, p_profile_id: profileId, p_edits: null, p_meta: meta(await consentIds(ctx.event.eventId)),
  })
  assert.equal(withIt.error?.message, 'consents_changed')

  const r = await rpc('accept_consent_request', {
    p_token_hash: t.hash, p_profile_id: profileId, p_edits: null, p_meta: meta(await adultIds(ctx.event.eventId, ctx.guardianId)),
  })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.status, 'accepted')
  const acc = await acceptancesOf(ctx.regId)
  assert.deepEqual(acc.map((a) => a.consent_kind).sort(), ['data_info', 'image', 'regulamin', 'service_regulamin'])
})

test('G-79 mark_consent_office records the event consents but the guardian one', async () => {
  const ctx = await awaitingAdult()
  const r = await rpc('mark_consent_office', { p_registration_id: ctx.regId, p_actor: owner.profileId })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data, true)
  const acc = await acceptancesOf(ctx.regId)
  assert.deepEqual(acc.map((a) => a.consent_kind).sort(), ['data_info', 'image', 'regulamin'])
  assert.ok(acc.every((a) => a.accepted_as === 'office' && a.consent_id !== ctx.guardianId))
})

// ---------------------------------------------------------------- G-80 a transfer's recipient

test('G-80 accept_transfer: the recipient (an adult) is not asked for the guardian consent and never accepts it', async () => {
  // The holder registered before the guardian consent existed.
  const plain = await createPublishedFreeEvent(owner, { competitions: [BIEG(), DZIECI()] })
  await enableTransfers(plain)
  const a = await freeEntry(plain)
  const { event, guardianId } = await withGuardianConsent(plain)
  const t = await inviteOk(a.reg.id, a.profileId)

  const all = { consentIds: await consentIds(event.eventId), serviceRegulamin: true }
  assert.equal((await acceptTransfer(event, t.hash, { consent: all })).error?.message, 'consents_changed')

  const r = await acceptTransfer(event, t.hash, {
    consent: { consentIds: await adultIds(event.eventId, guardianId), serviceRegulamin: true },
  })
  assert.equal(r.error, null, r.error?.message)
  const acc = await acceptancesOf(r.data.registrationId)
  assert.equal(acc.some((x) => x.consent_id === guardianId), false)
  assert.deepEqual(acc.map((x) => x.consent_kind).sort(), ['data_info', 'image', 'regulamin', 'service_regulamin'])
})

// ---------------------------------------------------------------- G-81 the organizer's list

test('G-81 registration_raw carries minorsOnly; an accepted guardian consent cannot be switched to everyone (consent_locked)', async () => {
  const { event, guardianId } = await withGuardianConsent()
  const raw = await rpc('registration_raw', { p_event_id: event.eventId })
  assert.equal(raw.error, null, raw.error?.message)
  const consents = raw.data.consents
  assert.equal(consents.find((k) => k.id === guardianId).minorsOnly, true)
  assert.ok(consents.filter((k) => k.id !== guardianId).every((k) => k.minorsOnly === false))

  // Nobody accepted it yet: switching is allowed (and staged).
  const free = await callFn('save-registration-section', owner, {
    eventId: event.eventId, section: 'form', value: { consents: [{ id: guardianId, text: GUARDIAN }] },
  })
  assert.equal(free.status, 200, JSON.stringify(free.body))
  await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'discard_changes' })

  // A child registered: the guardian accepted it, so it keeps its text and whom it applies to.
  const [, kids] = event.categoryIds
  const mum = runnerEmail('mum')
  const reg = await registerGroup(event, [minor(kids)], { profileId: await profileFor(mum) })
  assert.equal(reg.error, null, reg.error?.message)

  const flipped = await callFn('save-registration-section', owner, {
    eventId: event.eventId, section: 'form', value: { consents: [{ id: guardianId, text: GUARDIAN }] },
  })
  assert.equal(flipped.status, 409, JSON.stringify(flipped.body))
  assert.equal(flipped.body.code, 'consent_locked')
  const kept = await callFn('save-registration-section', owner, {
    eventId: event.eventId, section: 'form', value: { consents: [{ id: guardianId, text: GUARDIAN, minorsOnly: true }] },
  })
  assert.equal(kept.status, 200, JSON.stringify(kept.body))
  assert.equal((await one('event_consents', { id: guardianId })).minors_only, true)
})

// ---------------------------------------------------------------- G-82 register-free

const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`
async function call(fn, body, session) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': ip(), cookie: session.cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const grownUp = (email) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', city: 'Gliwice', club: 'Leszy',
})
const child = { firstName: 'Zosia', lastName: 'Leśna', birthDate: '2016-05-05', gender: 'K', phone: '600100200', city: 'Gliwice', club: 'Leszy' }

test('G-82 register-free: an adult alone does not send it; a parent with a child must', async () => {
  const { event, guardianId } = await withGuardianConsent()
  const [c9, kids] = event.categoryIds
  const ids = await adultIds(event.eventId, guardianId)

  const me = runnerEmail('solo')
  const solo = await call('register-free', {
    categoryId: c9, person: grownUp(me), acceptedConsentIds: ids, serviceRegulamin: true,
  }, await sessionFor(me))
  assert.equal(solo.status, 201, JSON.stringify(solo.body))

  const mum = runnerEmail('mum')
  const session = await sessionFor(mum)
  const people = [{ categoryId: c9, person: grownUp(mum) }, { categoryId: kids, person: child, guardianConsent: true }]
  const without = await call('register-free', { people, acceptedConsentIds: ids, serviceRegulamin: true }, session)
  assert.equal(without.status, 400, JSON.stringify(without.body))
  assert.equal(without.body.code, 'consents_required')
  const ok = await call('register-free', { people, acceptedConsentIds: [...ids, guardianId], serviceRegulamin: true }, session)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
})
