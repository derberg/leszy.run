// A registered runner's participant gets an emoji (migration 20261121100000): the account's
// avatar_emoji for the person who registered with it, a random one from the same pool for
// an added adult and a child. Scenario PE-1 in docs/registration/scenario-matrix.md.
// LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { rows, runnerEmail, profileFor } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, registerGroup } from './helpers/groups.js'
import { POOL } from '../../backend/src/lib/emoji.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

test('PE-1 a free family: self gets the account avatar, the added adult and the child a pool emoji', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(50), DZIECI(50)] })
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('self')
  const profileId = await profileFor(me)
  const [profile] = await rows('profiles', { id: profileId })
  assert.ok(profile.avatar_emoji, 'a new profile draws an avatar')

  const r = await registerGroup(event, [
    adult(c9, 'self', me),
    adult(c9, 'adult', runnerEmail('adult'), { firstName: 'Jan', gender: 'M', ageGroupLabel: 'M open' }),
    minor(kids),
  ], { profileId })
  assert.equal(r.error, null, r.error?.message)
  const out = r.data.registrations

  const parts = await rows('participants', { event_id: event.eventId })
  const emojiOf = (i) => parts.find((p) => p.id === out[i].participantId).emoji
  assert.equal(emojiOf(0), profile.avatar_emoji, 'the runner keeps the account emoji')
  for (const i of [1, 2]) assert.ok(POOL.includes(emojiOf(i)), `person ${i} got a pool emoji, not ${emojiOf(i)}`)
  assert.notEqual(emojiOf(1), emojiOf(2), 'a free pool emoji is preferred over a used one')
})
