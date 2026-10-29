// P2-R31: the nationality select's country list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNTRY_CODES, countryOptions, isCountryCode } from '../../../supabase/functions/_shared/registration/countries.js'

test('W-64 ISO 3166-1 alpha-2: 249 unique upper-case codes, each named in Polish by Intl', () => {
  assert.equal(COUNTRY_CODES.length, 249)
  assert.equal(new Set(COUNTRY_CODES).size, 249)
  const names = new Intl.DisplayNames(['pl'], { type: 'region' })
  for (const c of COUNTRY_CODES) {
    assert.match(c, /^[A-Z]{2}$/)
    assert.notEqual(names.of(c), c, c)
  }
  assert.equal(isCountryCode('PL'), true)
  assert.equal(isCountryCode('pl'), false)
  assert.equal(isCountryCode('XK'), false)
  assert.equal(isCountryCode(null), false)
})

test('W-64 countryOptions: Polska first, the rest by Polish name', () => {
  const opts = countryOptions()
  assert.equal(opts.length, 249)
  assert.deepEqual(opts[0], { code: 'PL', name: 'Polska' })
  assert.ok(opts.some((o) => o.code === 'DE' && o.name === 'Niemcy'))
  const rest = opts.slice(1).map((o) => o.name)
  assert.deepEqual(rest, [...rest].sort(new Intl.Collator('pl').compare))
})
