// A registered runner's participant gets an emoji (migration 20261121100000): the account's
// avatar_emoji for the person who registered with it, a random one from the same pool for
// an added adult, a child and a team member. Scenarios PE-1…PE-4 in
// docs/registration/scenario-matrix.md. LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { one, rows, runnerEmail, profileFor } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, registerGroup } from './helpers/groups.js'
import { freeTeamEvent, teamOk } from './helpers/teams.js'
import { accept, enableTransfers, freeEntry, inviteOk, paidEntry } from './helpers/transfers.js'
import { POOL } from '../../backend/src/lib/emoji.js'

let owner
before(async () => {
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const avatarOf = async (email) => {
  const profile = await one('profiles', { id: await profileFor(email) })
  assert.ok(POOL.includes(profile.avatar_emoji), `a new profile draws a pool avatar, not ${profile.avatar_emoji}`)
  return profile.avatar_emoji
}
const emojiOfRegistration = async (registrationId) => {
  const reg = await one('registrations', { id: registrationId })
  assert.ok(reg.participant_id, 'a confirmed entry has a participant')
  return (await one('participants', { id: reg.participant_id })).emoji
}

test('PE-1 a free family: self gets the account avatar, the added adult and the child a pool emoji', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(50), DZIECI(50)] })
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('self')
  const avatar = await avatarOf(me)

  const r = await registerGroup(event, [
    adult(c9, 'self', me),
    adult(c9, 'adult', runnerEmail('adult'), { firstName: 'Jan', gender: 'M', ageGroupLabel: 'M open' }),
    minor(kids),
  ], { profileId: await profileFor(me) })
  assert.equal(r.error, null, r.error?.message)
  const out = r.data.registrations

  const parts = await rows('participants', { event_id: event.eventId })
  const emojiOf = (i) => parts.find((p) => p.id === out[i].participantId).emoji
  assert.equal(emojiOf(0), avatar, 'the runner keeps the account emoji')
  for (const i of [1, 2]) assert.ok(POOL.includes(emojiOf(i)), `person ${i} got a pool emoji, not ${emojiOf(i)}`)
  assert.notEqual(emojiOf(1), emojiOf(2), 'a free pool emoji is preferred over a used one')
})

test('PE-2 a paid entry: the participant made when the payment confirms carries the account avatar', async () => {
  const event = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: [BIEG(50)] })
  const email = runnerEmail('paid')
  const avatar = await avatarOf(email)
  const { reg } = await paidEntry(event, { email })
  assert.equal(await emojiOfRegistration(reg.id), avatar)
})

test('PE-3 a free team: the captain gets the account avatar, every other member a pool emoji', async () => {
  const event = await freeTeamEvent(owner)
  const out = await teamOk(event)
  const regs = await rows('registrations', { team_id: out.teamId })
  assert.equal(regs.length, 4)
  const cap = regs.find((r) => r.profile_id)
  const capEmail = cap.email
  assert.equal(await emojiOfRegistration(cap.id), await avatarOf(capEmail), 'the captain keeps the account emoji')
  const others = await Promise.all(regs.filter((r) => r.id !== cap.id).map((r) => emojiOfRegistration(r.id)))
  for (const e of others) assert.ok(POOL.includes(e), `a member got a pool emoji, not ${e}`)
})

test('PE-4 a transfer: the recipient\'s new participant carries the recipient\'s own avatar', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(50)] })
  await enableTransfers(event)
  const holder = await freeEntry(event)
  const t = await inviteOk(holder.reg.id, holder.profileId)
  const to = runnerEmail('recipient')
  const avatar = await avatarOf(to)
  const r = await accept(event, t.hash, { email: to })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(await emojiOfRegistration(r.data.registrationId), avatar)
})
