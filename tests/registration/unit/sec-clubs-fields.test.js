import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clubFieldsError, clubNameError, clubWebsite, CLUB_WEBSITE_ERROR, clubContactEmail, clubContactPhone, CLUB_EMAIL_ERROR, CLUB_PHONE_ERROR, VOIVODESHIPS } from '../../../supabase/functions/_shared/clubFields.js'
import { REGION_SLUG_TO_DB } from '../../../public/src/lib/biegi-mappings.js'
import { removedMemberMayRejoin } from '../../../supabase/functions/_shared/clubInvites.js'

test('the voivodeship list is the calendar\'s capitalised one', () => {
  assert.deepEqual([...VOIVODESHIPS].sort(), Object.values(REGION_SLUG_TO_DB).sort())
  assert.equal(VOIVODESHIPS.length, 16)
})

test('club name 2..100 characters', () => {
  assert.equal(clubNameError('KB'), null)
  assert.equal(clubNameError('a'.repeat(100)), null)
  assert.ok(clubNameError('a'.repeat(101)))
  assert.ok(clubNameError('a'))
  assert.ok(clubNameError(undefined))
})

test('description, city, voivodeship, is_public', () => {
  assert.equal(clubFieldsError({}), null)
  assert.equal(clubFieldsError({ description: null, city: null, voivodeship: null }), null)
  assert.equal(clubFieldsError({ description: 'a'.repeat(2000), city: 'a'.repeat(100), voivodeship: 'Małopolskie', is_public: false }), null)
  assert.ok(clubFieldsError({ description: 'a'.repeat(2001) }))
  assert.ok(clubFieldsError({ description: { html: '<b>' } }))
  assert.ok(clubFieldsError({ city: 'a'.repeat(101) }))
  assert.ok(clubFieldsError({ city: 7 }))
  assert.ok(clubFieldsError({ voivodeship: 'małopolskie' }), 'lowercase is not a stored value')
  assert.ok(clubFieldsError({ voivodeship: 'Bawaria' }))
  assert.equal(clubFieldsError({ voivodeship: '' }), null)
  assert.ok(clubFieldsError({ is_public: 'false' }))
  assert.ok(clubFieldsError({ is_public: null }))
})

test('a removed member comes back only through a direct invite', () => {
  assert.equal(removedMemberMayRejoin(undefined), true)
  assert.equal(removedMemberMayRejoin('left', { kind: 'link' }), true)
  assert.equal(removedMemberMayRejoin('removed', { kind: 'link' }), false)
  assert.equal(removedMemberMayRejoin('removed'), false, 'request-join passes no invite')
  assert.equal(removedMemberMayRejoin('removed', { kind: 'direct' }), true)
})

test('accept-invite and request-join refuse a removed member before writing', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const fn of ['accept-invite', 'request-join']) {
    const src = await readFile(new URL(`../../../supabase/functions/${fn}/index.js`, import.meta.url), 'utf8')
    const check = src.indexOf('removedMemberMayRejoin(')
    assert.ok(check > 0, `${fn} calls removedMemberMayRejoin`)
    assert.ok(check < src.indexOf(".from('club_members')\n      .upsert"), `${fn} checks before the upsert`)
  }
})

test('clubWebsite: an http(s) address, trimmed; empty clears it; anything else refused', () => {
  assert.deepEqual(clubWebsite(' https://zatyrani.pl '), { value: 'https://zatyrani.pl' })
  assert.deepEqual(clubWebsite('http://klub.example.org/o-nas'), { value: 'http://klub.example.org/o-nas' })
  assert.deepEqual(clubWebsite(''), { value: null })
  assert.deepEqual(clubWebsite('   '), { value: null })
  assert.deepEqual(clubWebsite(null), { value: null })
  for (const bad of ['zatyrani.pl', 'javascript:alert(1)', 'ftp://x.pl', 'https://a b.pl', 42, `https://x.pl/${'a'.repeat(500)}`]) {
    assert.deepEqual(clubWebsite(bad), { error: CLUB_WEBSITE_ERROR }, String(bad).slice(0, 40))
  }
})

test('clubContactEmail / clubContactPhone: the registration rules, trimmed; empty clears', () => {
  assert.deepEqual(clubContactEmail(' Biuro@Klub.PL '), { value: 'biuro@klub.pl' })
  assert.deepEqual(clubContactEmail(''), { value: null })
  for (const bad of ['biuro@klub', 'x@gmail..com', 'a b@klub.pl', 7]) assert.deepEqual(clubContactEmail(bad), { error: CLUB_EMAIL_ERROR }, String(bad))
  assert.deepEqual(clubContactPhone(' +48  600 100-200 '), { value: '+48 600 100-200' })
  assert.deepEqual(clubContactPhone(null), { value: null })
  for (const bad of ['600', 'zadzwoń', '+48 600 100 200 300 400 500', 7]) assert.deepEqual(clubContactPhone(bad), { error: CLUB_PHONE_ERROR }, String(bad))
})
