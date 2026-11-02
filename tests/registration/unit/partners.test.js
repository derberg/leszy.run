import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PARTNER_NAME, MAX_PARTNER_NOTE, partnerName, partnerNote, partnerUrl,
} from '../../../supabase/functions/_shared/registration/partners.js'

// Event partners, task 2: the three field rules organizer-partners applies (and the admin app
// will, task 4). null means "no value", undefined means "invalid".

test('partnerName: trimmed, 1–80 characters, else null', () => {
  assert.equal(MAX_PARTNER_NAME, 80)
  assert.equal(partnerName('  a '), 'a')
  assert.equal(partnerName('x'.repeat(80)), 'x'.repeat(80))
  assert.equal(partnerName(` ${'x'.repeat(80)} `), 'x'.repeat(80), 'the limit counts the trimmed name')
  assert.equal(partnerName('x'.repeat(81)), null)
  for (const bad of ['', '   ', null, undefined, 42, {}, ['a']]) assert.equal(partnerName(bad), null, JSON.stringify(bad))
})

test('partnerNote: blank or absent → null, at most 500 characters, anything else undefined', () => {
  assert.equal(MAX_PARTNER_NOTE, 500)
  for (const blank of ['', '   ', null, undefined]) assert.equal(partnerNote(blank), null, JSON.stringify(blank))
  assert.equal(partnerNote(' umowa '), 'umowa')
  assert.equal(partnerNote('n'.repeat(500)), 'n'.repeat(500))
  assert.equal(partnerNote('n'.repeat(501)), undefined)
  for (const bad of [42, {}, ['a'], true]) assert.equal(partnerNote(bad), undefined, JSON.stringify(bad))
})

test('partnerUrl: blank or absent → null, an http(s) address of at most 500 characters, anything else undefined', () => {
  for (const blank of ['', '  ', null, undefined]) assert.equal(partnerUrl(blank), null, JSON.stringify(blank))
  assert.equal(partnerUrl('https://x.pl'), 'https://x.pl')
  assert.equal(partnerUrl(' http://sklep.pl/a?b=1 '), 'http://sklep.pl/a?b=1')
  assert.equal(partnerUrl('HTTPS://Sklep.pl'), 'HTTPS://Sklep.pl')
  const long = `https://${'a'.repeat(489)}.pl`
  assert.equal(long.length, 500)
  assert.equal(partnerUrl(long), long)
  assert.equal(partnerUrl(`${long}x`), undefined, 'a 501-character address')
  for (const bad of ['ftp://x', 'javascript:x', 'javascript:alert(1)', 'sklep.pl', 'https://', 'https://a b.pl', 42, {}]) {
    assert.equal(partnerUrl(bad), undefined, JSON.stringify(bad))
  }
})

test('organizer-partners never consults the money switch (PAID_REGISTRATION_ENABLED holds vouchers, not partners)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../../supabase/functions/organizer-partners/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /moneyLive|moneyFeaturesLive|PAYMENTS_OFF_REFUSAL|flags\.js/)
  assert.match(src, /guardRequest\(req\)/)
})
