import { test as base } from '@playwright/test'
import { sessionFor } from '../helpers/stack.js'

// Independent browser contexts, one per audience, each logged in as that
// person (no email round trip). Emails match supabase/seed.sql club members
// so owner/admin/member really hold those roles in zatyrani-test (registration
// enabled), and innyOwner/innyAdmin/innyMember in inny-klub (not enabled).
export const ACTOR_EMAILS = {
  owner: 'owner@zatyrani-test.local',
  admin: 'admin@zatyrani-test.local',
  member: 'member@zatyrani-test.local',
  innyOwner: 'owner@inny-klub.local',
  innyAdmin: 'admin@inny-klub.local',
  innyMember: 'member@inny-klub.local',
  runner: 'runner@test.local',
  viewer: null, // anonymous
}

async function actorContext(browser, email) {
  const context = await browser.newContext()
  if (email) {
    const { token } = await sessionFor(email)
    await context.addCookies([{
      name: 'leszy_session', value: token, domain: 'localhost', path: '/',
      httpOnly: true, secure: false, sameSite: 'Lax',
    }])
  }
  return context
}

export const test = base.extend({
  actors: async ({ browser }, use) => {
    const contexts = {}
    for (const [name, email] of Object.entries(ACTOR_EMAILS)) {
      contexts[name] = await actorContext(browser, email)
    }
    await use(contexts)
    await Promise.all(Object.values(contexts).map((c) => c.close()))
  },
})
export { expect } from '@playwright/test'
