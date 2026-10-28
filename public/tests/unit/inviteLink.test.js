import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inviteUrl, inviteFromPath, postAuthPath, isRegistrationPath } from '../../src/lib/inviteLink.js'

describe('inviteUrl', () => {
  it('builds the invite address', () => {
    assert.equal(
      inviteUrl('https://www.leszy.run', 'zatyrani', '982e0cb01e'),
      'https://www.leszy.run/klub/zatyrani/dolacz?kod=982e0cb01e',
    )
  })
})

describe('inviteFromPath', () => {
  it('reads slug and code from an invite path', () => {
    assert.deepEqual(inviteFromPath('/klub/zatyrani/dolacz?kod=982e0cb01e'), { slug: 'zatyrani', code: '982e0cb01e' })
    assert.deepEqual(inviteFromPath('/klub/zatyrani/dolacz?kod=982e0cb01e&beta=1'), { slug: 'zatyrani', code: '982e0cb01e' })
  })

  it('ignores every other path', () => {
    assert.equal(inviteFromPath('/profil'), null)
    assert.equal(inviteFromPath('/klub/zatyrani/panel?kod=982e0cb01e'), null)
    assert.equal(inviteFromPath('/klub/zatyrani/dolacz'), null)
    assert.equal(inviteFromPath(null), null)
  })
})

describe('postAuthPath', () => {
  const from = '/klub/zatyrani/dolacz?kod=982e0cb01e'

  it('sends a returning user straight to where they came from', () => {
    assert.equal(postAuthPath({ from, hasUsername: true }), from)
    assert.equal(postAuthPath({ from: null, hasUsername: true }), '/profil')
  })

  it('sends a new user through onboarding first, carrying the destination along', () => {
    assert.equal(postAuthPath({ from, hasUsername: false }), `/onboarding?from=${encodeURIComponent(from)}`)
    assert.equal(postAuthPath({ from: null, hasUsername: false }), '/onboarding')
  })
})

describe('postAuthPath for registration pages (spec 14.17)', () => {
  it('skipOnboarding sends a new account straight to the registration page', () => {
    assert.equal(postAuthPath({ from: '/events/x/zapisano', hasUsername: false, skipOnboarding: true }), '/events/x/zapisano')
  })

  it('without the flag a new account still goes through onboarding', () => {
    assert.equal(postAuthPath({ from: '/events/x/zapisano', hasUsername: false }), `/onboarding?from=${encodeURIComponent('/events/x/zapisano')}`)
    assert.equal(postAuthPath({ from: '/events/x/zapisano', hasUsername: false, skipOnboarding: false }), `/onboarding?from=${encodeURIComponent('/events/x/zapisano')}`)
  })

  it('skipOnboarding with nowhere to go falls back to onboarding', () => {
    assert.equal(postAuthPath({ from: null, hasUsername: false, skipOnboarding: true }), '/onboarding')
  })
})

describe('isRegistrationPath', () => {
  it('the form and the confirmation page are registration pages', () => {
    assert.equal(isRegistrationPath('/events/bieg-leszego/zapis/0b6f2b0e-6c1a-4f43-9a51-6a9a1b2c3d4e'), true)
    assert.equal(isRegistrationPath('/events/bieg-leszego/zapisano'), true)
  })

  it('anything else is not', () => {
    for (const p of [null, '', '/events/bieg-leszego', '/events/bieg-leszego/trasa', '/events/bieg-leszego/results',
      '/klub/zatyrani/dolacz?kod=1', '/events/a/zapisano/extra', '//evil.example/events/a/zapisano']) {
      assert.equal(isRegistrationPath(p), false, String(p))
    }
  })
})
