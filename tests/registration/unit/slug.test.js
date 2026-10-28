import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, isValidSlug } from '../../../supabase/functions/_shared/registration/slug.js'

test('W-04 slugify transliterates Polish letters', () => {
  assert.equal(slugify('Charytatywny Bieg Łęgowego 2026!'), 'charytatywny-bieg-legowego-2026')
  assert.equal(slugify('Żółć Ąć Ęń Śó Źł'), 'zolc-ac-en-so-zl')
})

test('slugify caps at 80 without a trailing dash', () => {
  const s = slugify('a'.repeat(79) + ' bbb')
  assert.ok(s.length <= 80)
  assert.ok(!s.endsWith('-'))
})

test('isValidSlug', () => {
  assert.equal(isValidSlug('abc-def-1'), true)
  assert.equal(isValidSlug('ab'), false)
  assert.equal(isValidSlug('a'.repeat(81)), false)
  assert.equal(isValidSlug('Abc'), false)
  assert.equal(isValidSlug('abc--def'), false)
  assert.equal(isValidSlug('-abc'), false)
  assert.equal(isValidSlug('abc-'), false)
  assert.equal(isValidSlug(null), false)
})
