import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateContribution, isHttpUrl, LIMITS } from '../../../supabase/functions/_shared/contributionValidation.js'

const UUID = '3f1c2a9e-1b2c-4d5e-8f90-123456789abc'
const submission = (payload) => validateContribution({ type: 'event_submission', payload: { name: 'Bieg', date: '2026-12-01', ...payload } })

test('the public forms\' own bodies pass', () => {
  assert.equal(validateContribution({ type: 'general_feedback', payload: { category: 'bug', message: 'Coś nie działa' } }), null)
  assert.equal(validateContribution({
    type: 'event_report', reference_id: UUID,
    payload: { field: 'date', old_value: '2026-12-01', suggested_value: '2026-12-02', source_url: null, note: null },
  }), null)
  assert.equal(submission({
    location: 'Gdańsk', voivodeship: 'Pomorskie', distances: ['5 km', 10, '21,1 km'], event_type: ['trail'],
    registration_url: 'https://zapisy.example.pl/bieg', website: null, regulamin_url: '',
    price_from: 50, price_to: 120, registration_deadline: '2026-11-20', lat: 54.35, lng: 18.65,
  }), null)
})

test('URL fields must be http(s) or empty', () => {
  for (const field of ['registration_url', 'website', 'regulamin_url']) {
    assert.match(submission({ [field]: 'javascript:alert(1)' }), new RegExp(`^${field}:`))
    assert.match(submission({ [field]: 'data:text/html,x' }), new RegExp(`^${field}:`))
    assert.match(submission({ [field]: 'https://x.pl/' + 'a'.repeat(LIMITS.url) }), new RegExp(`^${field}:`))
    assert.equal(submission({ [field]: '' }), null)
  }
  assert.match(validateContribution({ type: 'event_report', reference_id: UUID, payload: { source_url: 'ftp://x' } }), /^source_url:/)
  assert.equal(isHttpUrl('http://example.com'), true)
  assert.equal(isHttpUrl('javascript:void(0)'), false)
})

test('text lengths are capped', () => {
  assert.match(submission({ name: 'a'.repeat(201) }), /^name:/)
  assert.match(submission({ location: 'a'.repeat(201) }), /^location:/)
  assert.match(validateContribution({ type: 'general_feedback', payload: { message: 'a'.repeat(5001) } }), /^message:/)
  assert.equal(validateContribution({ type: 'general_feedback', payload: { message: 'a'.repeat(5000) } }), null)
  assert.match(validateContribution({ type: 'event_report', reference_id: UUID, payload: { note: 'a'.repeat(5001) } }), /^note:/)
  assert.match(validateContribution({ type: 'event_report', reference_id: UUID, payload: { field: { x: 1 } } }), /^field:/)
})

test('required fields and types', () => {
  assert.match(validateContribution({ type: 'event_submission', payload: { date: '2026-12-01' } }), /^name:/)
  assert.match(submission({ date: '1 grudnia' }), /^date:/)
  assert.match(validateContribution({ type: 'general_feedback', payload: { message: '   ' } }), /^message:/)
  assert.match(validateContribution({ type: 'general_feedback', payload: [] }), /^payload:/)
  assert.match(validateContribution({ type: 'nope' }), /^type:/)
})

test('numbers are finite and in range', () => {
  assert.match(submission({ lat: 91 }), /^lat:/)
  assert.match(submission({ lng: -181 }), /^lng:/)
  assert.match(submission({ lat: '54' }), /^lat:/)
  assert.match(submission({ price_from: -1 }), /^price_from:/)
  assert.match(submission({ price_to: 100001 }), /^price_to:/)
  assert.match(submission({ price_to: Number.POSITIVE_INFINITY }), /^price_to:/)
  assert.equal(submission({ price_from: 0, price_to: 100000, lat: -90, lng: 180 }), null)
})

test('distances: an array of at most 30 numbers or short strings', () => {
  assert.match(submission({ distances: '5 km' }), /^distances:/)
  assert.match(submission({ distances: Array(31).fill(5) }), /^distances:/)
  assert.match(submission({ distances: [{ km: 5 }] }), /^distances:/)
  assert.match(submission({ distances: ['x'.repeat(51)] }), /^distances:/)
  assert.equal(submission({ distances: Array(30).fill('5 km') }), null)
})

test('reference_id is a UUID, and a report needs one', () => {
  assert.match(validateContribution({ type: 'event_report', reference_id: "1' or 1=1", payload: {} }), /^reference_id:/)
  assert.match(validateContribution({ type: 'event_report', payload: {} }), /^reference_id: required/)
  assert.match(validateContribution({ type: 'general_feedback', reference_id: 42, payload: { message: 'x' } }), /^reference_id:/)
})

test('submit-contribution validates and throttles before writing', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../../../supabase/functions/submit-contribution/index.js', import.meta.url), 'utf8')
  assert.match(src, /validateContribution\(/)
  assert.match(src, /checkAndIncrement\(supabaseAdmin, `contribution:\$\{session\.userId\}`, CONTRIBUTION_LIMIT/)
  assert.match(src, /CONTRIBUTION_LIMIT = 20/)
  assert.ok(src.indexOf('checkAndIncrement(') < src.indexOf(".insert(row)"), 'throttle runs before the first insert')
})
