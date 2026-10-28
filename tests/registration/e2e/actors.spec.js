import { test, expect } from './fixtures.js'

test('each actor context carries its own session through the /edge proxy', async ({ actors }) => {
  const who = {}
  for (const name of ['owner', 'admin', 'member', 'runner', 'viewer']) {
    const res = await actors[name].request.get('http://localhost:5174/edge/auth-me')
    who[name] = (await res.json()).user?.email ?? null
  }
  expect(who).toEqual({
    owner: 'owner@zatyrani-test.local',
    admin: 'admin@zatyrani-test.local',
    member: 'member@zatyrani-test.local',
    runner: 'runner@test.local',
    viewer: null,
  })
})
