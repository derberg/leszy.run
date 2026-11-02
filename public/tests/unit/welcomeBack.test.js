import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { welcomeBackText } from '../../src/lib/welcomeBack.js'

describe('welcomeBackText', () => {
  it('greets by display name first', () => {
    assert.match(welcomeBackText({ display_name: 'Łukasz', username: 'derberg' }), /^Witaj ponownie, Łukasz!/)
  })
  it('falls back to the username', () => {
    assert.match(welcomeBackText({ display_name: ' ', username: 'derberg' }), /^Witaj ponownie, derberg!/)
  })
  it('greets without a name when the profile has none', () => {
    assert.match(welcomeBackText(null), /^Witaj ponownie! Masz już konto/)
  })
})
