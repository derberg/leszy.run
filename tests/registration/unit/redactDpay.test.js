// Ruling P3-R2: every dpay payload is redacted before it is logged to payment_events.
// The database refuses an `email` key at any depth (the backstop); redactDpay is the
// one place that makes a payload pass it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactDpay, EMAIL_MASK } from '../../../supabase/functions/_shared/registration/redactDpay.js'

test('P-13 redactDpay drops email keys at every depth and in any case', () => {
  const ipn = {
    id: 'T1', amount: '60.55', email: 'a@b.pl', type: 'transfer',
    payer: { Email: 'a@b.pl', name: 'Ola', contact: { EMAIL: 'a@b.pl', e_mail: 'a@b.pl', 'e-mail': 'a@b.pl', payerEmail: 'a@b.pl' } },
    attempts: [{ email: 'a@b.pl', n: 1 }],
  }
  assert.deepEqual(redactDpay(ipn), {
    id: 'T1', amount: '60.55', type: 'transfer',
    payer: { name: 'Ola', contact: {} },
    attempts: [{ n: 1 }],
  })
})

test('P-13 redactDpay masks an address inside any string value, keeps the rest of the string', () => {
  const out = redactDpay({ note: 'zapłacił a.b+c@x-y.example.pl dziś', custom: 'order-1', msg: 'https://secure.dpay.pl/pay/abc' })
  assert.deepEqual(out, { note: `zapłacił ${EMAIL_MASK} dziś`, custom: 'order-1', msg: 'https://secure.dpay.pl/pay/abc' })
  assert.equal(redactDpay('a@b.pl'), EMAIL_MASK)
  assert.deepEqual(redactDpay(['x', 'p@q.com']), ['x', EMAIL_MASK])
})

test('P-13 redactDpay returns a deep copy and never mutates its input', () => {
  const input = { a: { email: 'a@b.pl', b: [1, { c: 'x@y.pl' }] } }
  const snapshot = structuredClone(input)
  const out = redactDpay(input)
  assert.deepEqual(input, snapshot)
  assert.notEqual(out.a, input.a)
  assert.notEqual(out.a.b, input.a.b)
  assert.deepEqual(out, { a: { b: [1, { c: EMAIL_MASK }] } })
})

test('P-13 redactDpay keeps numbers, booleans and null; undefined becomes null', () => {
  assert.deepEqual(redactDpay({ n: 1, t: true, f: false, z: null, u: undefined }), { n: 1, t: true, f: false, z: null, u: null })
  assert.equal(redactDpay(null), null)
  assert.equal(redactDpay(7), 7)
  assert.equal(redactDpay(undefined), null)
})

test('P-13 a key that only mentions email but holds no address stays (it names a flag, not a person)', () => {
  assert.deepEqual(redactDpay({ emailVerified: true, email_sha256: 'ab'.repeat(32) }), { emailVerified: true, email_sha256: 'ab'.repeat(32) })
})
