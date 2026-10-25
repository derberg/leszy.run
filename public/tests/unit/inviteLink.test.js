import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inviteUrl, inviteFromPath, postAuthPath } from '../../src/lib/inviteLink.js'

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
