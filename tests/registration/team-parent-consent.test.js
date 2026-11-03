// A child in a relay team whose parent is not the captain (scenarios TP-20…TP-29 in
// docs/registration/scenario-matrix.md). Migration 20261112100000_team_minor_parent_consent.sql:
// the child is stored with the named parent as guardian, waits for that parent's consent, and the
// parent accepts on /zgoda as 'guardian'. LOCAL stack only; every event and address is random.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EDGE_PROXY, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn } from './helpers/registrationFixtures.js'
import { consentIds, one, profileFor, rows, rpc, runnerEmail } from './helpers/orders.js'
import { adult, groupMeta, minor } from './helpers/groups.js'
import { captain, createTeam, freeTeamEvent, squadEdit, teamOk } from './helpers/teams.js'
import { newToken } from '../../supabase/functions/_shared/registration/tokens.js'

const GUARDIAN = 'Jako opiekun zgadzam się na udział dziecka w zawodach.'
const PARENT_SUBJECT = /^Zapisano dziecko na .+ — zaakceptuj udział dziecka$/
const TOKEN_RE = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/

let owner, stopCapture
before(async () => {
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (stopCapture) await stopCapture() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`
const acceptancesOf = (registrationId) => rows('consent_acceptances', { registration_id: registrationId })
const regOf = (id) => one('registrations', { id })

async function call(fn, body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function waitForMail(email, pred = () => true) {
  for (let i = 0; i < 40; i++) {
    const found = (await messagesTo(email)).filter(pred)
    if (found.length) return found
    await sleep(250)
  }
  return []
}

/** A free team event with the guardian's minors-only consent live → { event, cat, guardianId }. */
async function teamEventWithGuardianConsent() {
  const event = await freeTeamEvent(owner)
  let r = await callFn('save-registration-section', owner, {
    eventId: event.eventId, section: 'form', value: { consents: [{ text: GUARDIAN, minorsOnly: true }] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'publish_changes', notify: { send: false } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const g = await one('event_consents', { event_id: event.eventId, kind: 'custom' })
  return { event, cat: event.categoryIds[0], guardianId: g.id }
}

const named = (cat, parentEmail, over = {}) => ({
  ...minor(cat, { firstName: `Zosia${crypto.randomBytes(3).toString('hex')}`, ...over }),
  guardian: { name: 'Marta Leśna', email: parentEmail },
})

/** A confirmed free team: captain, an adult, a child whose parent is `parentEmail`. */
async function teamWithNamedParent({ parentEmail = runnerEmail('parent') } = {}) {
  const { event, cat, guardianId } = await teamEventWithGuardianConsent()
  const cap = captain()
  const members = [cap, adult(cat, 'adult'), named(cat, parentEmail)]
  const adultsOnly = (await consentIds(event.eventId)).filter((id) => id !== guardianId)
  const out = await teamOk(event, { members, meta: await groupMeta(event.eventId, { consentIds: adultsOnly }) })
  const childId = out.registrations[2].id
  return { event, cat, guardianId, out, cap, parentEmail, childId, captainProfile: await profileFor(cap.email) }
}

// ---------------------------------------------------------------- create_team_registration

test('TP-20 a named parent: the child is stored with that parent as guardian, awaiting, with no acceptance of the captain\'s', async () => {
  const { childId, parentEmail, captainProfile } = await teamWithNamedParent()
  const child = await regOf(childId)
  assert.equal(child.email, null)
  assert.equal(child.guardian_name, 'Marta Leśna')
  assert.equal(child.guardian_email, parentEmail.toLowerCase())
  assert.equal(child.guardian_profile_id, null)
  assert.equal(child.consent_state, 'awaiting')
  assert.equal(child.registered_by_profile_id, captainProfile)
  assert.deepEqual(await acceptancesOf(childId), [])
})

test('TP-21 with every child named, the minors-only consent is not the captain\'s: sending it → consents_changed', async () => {
  const { event, cat } = await teamEventWithGuardianConsent()
  const r = await createTeam(event, {
    members: [captain(), adult(cat, 'adult'), named(cat, runnerEmail('parent'))], meta: await groupMeta(event.eventId),
  })
  assert.equal(r.error?.message, 'consents_changed')
})

test('TP-22 a child the captain answers for beside a named one: the minors-only consent is required again, for that child only', async () => {
  const { event, cat, guardianId } = await teamEventWithGuardianConsent()
  const out = await teamOk(event, {
    members: [captain(), named(cat, runnerEmail('parent')), minor(cat, { firstName: 'Staś', gender: 'M' })],
    meta: await groupMeta(event.eventId),
  })
  const own = await acceptancesOf(out.registrations[2].id)
  assert.ok(own.some((a) => a.consent_id === guardianId && a.accepted_as === 'guardian'))
  assert.deepEqual(await acceptancesOf(out.registrations[1].id), [])
})

test('TP-23 the captain\'s own address as the parent\'s, or a malformed one → invalid_people, nothing written', async () => {
  const { event, cat, guardianId } = await teamEventWithGuardianConsent()
  const adultsOnly = (await consentIds(event.eventId)).filter((id) => id !== guardianId)
  const cap = captain()
  for (const email of [cap.email.toUpperCase(), 'nie-adres', '']) {
    const r = await createTeam(event, {
      members: [cap, adult(cat, 'adult'), named(cat, email)], meta: await groupMeta(event.eventId, { consentIds: adultsOnly }),
    })
    assert.equal(r.error?.message, 'invalid_people', email)
  }
  assert.deepEqual(await rows('teams', { category_id: cat }), [])
})

// ---------------------------------------------------------------- accept_consent_request

test('TP-24 the parent\'s account accepts: guardian_profile_id is the parent, every consent recorded as guardian, the child has no account', async () => {
  const { childId, parentEmail, guardianId, event } = await teamWithNamedParent()
  const { token, hash } = await newToken()
  assert.equal((await rpc('issue_consent_request', { p_registration_id: childId, p_token_hash: hash })).data, true)
  void token
  const parentProfile = await profileFor(parentEmail)
  const all = await consentIds(event.eventId)
  const r = await rpc('accept_consent_request', {
    p_token_hash: hash, p_profile_id: parentProfile, p_edits: null, p_meta: { consentIds: all, ip: '203.0.113.9', userAgent: 'test' },
  })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.status, 'accepted')
  const child = await regOf(childId)
  assert.equal(child.consent_state, 'accepted')
  assert.equal(child.guardian_profile_id, parentProfile)
  assert.equal(child.profile_id, null)
  const acc = await acceptancesOf(childId)
  assert.ok(acc.length >= all.length + 1)
  assert.ok(acc.every((a) => a.accepted_as === 'guardian' && a.accepted_by_profile_id === parentProfile))
  assert.ok(acc.some((a) => a.consent_id === guardianId))
  assert.ok(acc.some((a) => a.consent_kind === 'service_regulamin'))
})

test('TP-25 the captain\'s account cannot accept a child whose parent is named → profile_mismatch; an adult birth date → edit_invalid', async () => {
  const { childId, parentEmail, captainProfile, event } = await teamWithNamedParent()
  const { hash } = await newToken()
  await rpc('issue_consent_request', { p_registration_id: childId, p_token_hash: hash })
  const meta = { consentIds: await consentIds(event.eventId) }
  const asCaptain = await rpc('accept_consent_request', { p_token_hash: hash, p_profile_id: captainProfile, p_edits: null, p_meta: meta })
  assert.equal(asCaptain.error?.message, 'profile_mismatch')
  const grown = await rpc('accept_consent_request', {
    p_token_hash: hash, p_profile_id: await profileFor(parentEmail), p_edits: { birthDate: '1990-01-01' }, p_meta: meta,
  })
  assert.equal(grown.error?.message, 'edit_invalid')
  assert.equal((await regOf(childId)).consent_state, 'awaiting')
})

test('TP-26 mark_consent_office for a child: office, the minors-only consent included, recorded by the organizer', async () => {
  const { childId, guardianId } = await teamWithNamedParent()
  const done = await rpc('mark_consent_office', { p_registration_id: childId, p_actor: owner.profileId })
  assert.equal(done.data, true, done.error?.message)
  assert.equal((await regOf(childId)).consent_state, 'office')
  const acc = await acceptancesOf(childId)
  assert.ok(acc.some((a) => a.consent_id === guardianId))
  assert.ok(acc.every((a) => a.accepted_as === 'office' && a.accepted_by_profile_id === owner.profileId))
})

test('TP-27 consent_requests_missing lists a child awaiting a named parent', async () => {
  const { childId } = await teamWithNamedParent()
  const { data, error } = await rpc('consent_requests_missing', { p_limit: 5000 })
  assert.equal(error, null)
  assert.ok(data.some((x) => (x.consent_requests_missing ?? x) === childId))
})

// ---------------------------------------------------------------- the edge functions

test('TP-28 the captain\'s reminder goes to the parent, worded for a parent; /zgoda asks the parent\'s code, then the parent accepts with the guardian box', async () => {
  const { childId, parentEmail, cap, event } = await teamWithNamedParent()
  const captainSession = await sessionFor(cap.email)
  const sent = await call('remind-consent', { registrationId: childId }, captainSession)
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const [mail] = await waitForMail(parentEmail, (m) => PARENT_SUBJECT.test(m.subject))
  assert.ok(mail, 'the parent got the e-mail')
  assert.ok(mail.text.includes('Zaakceptuj udział dziecka'))
  const token = mail.text.match(TOKEN_RE)?.[1]
  assert.ok(token)

  // The link alone: the event and the child's first name, an address hint of the parent's.
  const anon = await call('consent-request', { token })
  assert.equal(anon.body.data.needsCode, true)
  assert.equal(anon.body.data.emailHint[0], parentEmail[0])
  // The captain's session is not the parent's.
  assert.equal((await call('consent-request', { token }, captainSession)).body.data.needsCode, true)

  const parent = await sessionFor(parentEmail)
  const full = await call('consent-request', { token }, parent)
  assert.equal(full.status, 200, JSON.stringify(full.body))
  assert.equal(full.body.data.asGuardian, true)
  assert.equal(full.body.data.person.email, null)
  const shown = full.body.data.consents.map((c) => c.id)
  assert.deepEqual([...shown].sort(), [...await consentIds(event.eventId)].sort(), 'every consent, the minors-only one included')

  const noBox = await call('accept-consent', { token, acceptedConsentIds: shown, shownConsentIds: shown, serviceRegulamin: true }, parent)
  assert.equal(noBox.status, 400)
  assert.equal(noBox.body.code, 'consents_required')
  const ok = await call('accept-consent', {
    token, acceptedConsentIds: shown, shownConsentIds: shown, serviceRegulamin: true, guardianConsent: true, edits: { club: 'UKS Las' },
  }, parent)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const child = await regOf(childId)
  assert.equal(child.consent_state, 'accepted')
  assert.equal(child.guardian_profile_id, parent.profileId)
  assert.equal(child.club, 'UKS Las')
})

test('TP-29 team-squad add: a child with a named parent needs no consents of the captain\'s and is asked of that parent', async () => {
  const { event, cat, out, cap } = await teamWithNamedParent()
  const parentEmail = runnerEmail('parent2')
  const captainProfile = await profileFor(cap.email)
  const person = { ...named(cat, parentEmail), role: 'minor' }
  delete person.categoryId
  const r = await squadEdit(event, out.teamId, captainProfile, { op: 'add', person }, { ip: '203.0.113.9', userAgent: 'test' })
  assert.equal(r.error, null, r.error?.message)
  const added = await regOf(r.data.added[0].id)
  assert.equal(added.consent_state, 'awaiting')
  assert.equal(added.guardian_email, parentEmail.toLowerCase())
  assert.deepEqual(await acceptancesOf(added.id), [])
})
