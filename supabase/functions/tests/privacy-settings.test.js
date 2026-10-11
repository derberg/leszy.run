import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePrivacySettings } from '../_shared/privacySettings.js'

describe('sanitizePrivacySettings', () => {
  it('keeps the four known flags as booleans', () => {
    const { value } = sanitizePrivacySettings({ display_name: false, club: true, bio: false, favorites: true }, {})
    assert.deepEqual(value, { display_name: false, club: true, bio: false, favorites: true })
  })

  it('merges onto what is already stored instead of replacing it', () => {
    const { value } = sanitizePrivacySettings({ bio: false }, { display_name: false, club: true, bio: true, favorites: true })
    assert.deepEqual(value, { display_name: false, club: true, bio: false, favorites: true })
  })

  it('refuses a non-boolean for a flag the SQL view casts to boolean', () => {
    const { error } = sanitizePrivacySettings({ display_name: 'tak' }, {})
    assert.match(error, /display_name/)
  })

  it('refuses a key it does not know', () => {
    const { error } = sanitizePrivacySettings({ evil: true }, {})
    assert.match(error, /evil/)
  })

  it('accepts only the two allowed values for club_public_name', () => {
    assert.equal(sanitizePrivacySettings({ club_public_name: 'nickname' }, {}).value.club_public_name, 'nickname')
    assert.equal(sanitizePrivacySettings({ club_public_name: 'display' }, {}).value.club_public_name, 'display')
    assert.ok(sanitizePrivacySettings({ club_public_name: 'whatever' }, {}).error)
  })

  it('refuses something that is not an object at all', () => {
    assert.ok(sanitizePrivacySettings('nope', {}).error)
    assert.ok(sanitizePrivacySettings(null, {}).error)
    assert.ok(sanitizePrivacySettings([true], {}).error)
  })
})
