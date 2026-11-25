// Organizer agreement changes are updates with a notice e-mail, never a re-acceptance (agreement
// §13 ust. 6, owner decision 2026-11-25). AU-01: a club that accepted only an older version is not
// blocked (organizer-status, create, list, publish). AU-02: the registration-jobs step
// agreement_notices e-mails the owner and admins of such a club once per version, never a member,
// a disabled club, a club already on the current version or a club with no agreement.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo } from './helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent, makeClub } from './helpers/registrationFixtures.js'
import { AGREEMENT_CHANGES, ORGANIZER_AGREEMENT_VERSION } from '../../supabase/functions/_shared/organizer.js'

const OLD = '2026-11-v1'
const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

async function jobs() {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET },
    body: '{}',
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.data
}

/** A club of its own whose only acceptance is `versions` (none: no agreement at all). */
async function clubOn(versions, { enabled = true } = {}) {
  const slug = `umowa-${rand()}`
  const club = await makeClub({ slug, enabled, agreement: false })
  for (const version of versions) {
    const { error } = await db().from('organizer_agreements').insert({ club_id: club.clubId, club_name: `Klub ${slug}`, version })
    if (error) throw error
  }
  return { ...club, slug }
}

const notices = (email) => messagesTo(email).then((m) => m.filter((x) => x.subject === 'Zaktualizowaliśmy umowę organizatora'))

before(async () => {
  localEnv()
  await resetThrottle()
})

test('AU-01 a club on an older agreement version: organizer-status says accepted, with acceptedVersion and currentVersion; create, list and publish are not blocked', async () => {
  const club = await clubOn([OLD])
  const owner = await sessionFor(club.ownerEmail)
  const st = await callFn('organizer-status', owner, { clubId: club.clubId })
  assert.equal(st.status, 200, JSON.stringify(st.body))
  assert.equal(st.body.data.agreementAccepted, true)
  assert.equal(st.body.data.acceptedVersion, OLD)
  assert.equal(st.body.data.currentVersion, ORGANIZER_AGREEMENT_VERSION)
  assert.equal(st.body.data.version, ORGANIZER_AGREEMENT_VERSION)
  assert.deepEqual(st.body.data.agreementChanges, [...AGREEMENT_CHANGES])
  assert.ok(st.body.data.agreementAcceptedAt)

  const l = await callFn('list-club-registration-events', owner, { clubId: club.clubId })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const published = await createPublishedFreeEvent(owner, { clubSlug: club.slug })
  const { data: rs } = await db().from('registration_settings').select('state').eq('event_id', published.eventId).single()
  assert.equal(rs.state, 'published')

  // „Rozumiem” (owner): the ordinary accept stores the current version; the strip goes away.
  const ack = await callFn('accept-organizer-agreement', owner, { clubId: club.clubId, version: ORGANIZER_AGREEMENT_VERSION })
  assert.equal(ack.status, 200, JSON.stringify(ack.body))
  const after = await callFn('organizer-status', owner, { clubId: club.clubId })
  assert.equal(after.body.data.acceptedVersion, ORGANIZER_AGREEMENT_VERSION)
  // An admin cannot record it.
  const adm = await sessionFor(club.adminEmail)
  const byAdmin = await callFn('accept-organizer-agreement', adm, { clubId: club.clubId, version: ORGANIZER_AGREEMENT_VERSION })
  assert.equal(byAdmin.status, 403)
})

test('AU-01b a club with no agreement at all is still refused (create, list, organizer-status)', async () => {
  const club = await clubOn([])
  const owner = await sessionFor(club.ownerEmail)
  const st = await callFn('organizer-status', owner, { clubId: club.clubId })
  assert.deepEqual([st.body.data.agreementAccepted, st.body.data.acceptedVersion], [false, null])
  const c = await callFn('create-registration-event', owner, { clubId: club.clubId, name: 'Bieg bez umowy' })
  assert.deepEqual([c.status, c.body.code], [409, 'agreement_required'])
})

test('AU-02 agreement_notices: owner and admins of a club on an older version, one e-mail per address, once per version; never a member, a disabled club, a current club or a club with none', async () => {
  const stale = await clubOn([OLD])
  const current = await clubOn([OLD, ORGANIZER_AGREEMENT_VERSION])
  const disabled = await clubOn([OLD], { enabled: false })
  const none = await clubOn([])

  const first = await jobs()
  assert.ok(first.agreementNotices >= 1, JSON.stringify(first))

  const [owner, adm] = [await notices(stale.ownerEmail), await notices(stale.adminEmail)]
  assert.equal(owner.length, 1)
  assert.equal(adm.length, 1)
  const m = owner[0]
  assert.ok(m.text.includes(ORGANIZER_AGREEMENT_VERSION))
  assert.ok(m.text.includes(`/klub/${stale.slug}/wydarzenia/umowa`))
  assert.ok(m.text.includes('w ciągu 7 dni'))
  for (const c of AGREEMENT_CHANGES) assert.ok(m.text.includes(c))
  assert.equal((await notices(stale.memberEmail)).length, 0, 'never a plain member')
  for (const c of [current, disabled, none]) {
    for (const e of [c.ownerEmail, c.adminEmail]) assert.equal((await notices(e)).length, 0, e)
  }
  const { data: row } = await db().from('organizer_agreement_notices').select('*')
    .eq('club_id', stale.clubId).eq('version', ORGANIZER_AGREEMENT_VERSION).single()
  assert.ok(row.claimed_at && row.sent_at)
  const { data: others } = await db().from('organizer_agreement_notices').select('club_id')
    .in('club_id', [current.clubId, disabled.clubId, none.clubId])
  assert.deepEqual(others, [])

  // A second run sends nothing again.
  await jobs()
  assert.equal((await notices(stale.ownerEmail)).length, 1)
  assert.equal((await notices(stale.adminEmail)).length, 1)
})

test('AU-03 organizer_agreement_notices is service-role only', async () => {
  const { anonKey, url } = localEnv()
  const res = await fetch(`${url}/rest/v1/organizer_agreement_notices?select=club_id`, { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` } })
  assert.notEqual(res.status, 200)
})
