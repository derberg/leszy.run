import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkinToken, checkinUrl, generatePin } from '../src/lib/checkinLink.js'
import { checkinToken as edgeToken, sameToken } from '../../supabase/functions/_shared/checkinToken.js'

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const ID = '7f3c2a10-4b5e-4c6d-8e9f-0a1b2c3d4e5f'

test('backend and edge function derive the same token', async () => {
  const backend = checkinToken(KEY, ID)
  assert.equal(backend.length, 32)
  assert.match(backend, /^[A-Za-z0-9_-]+$/)
  assert.equal(await edgeToken(KEY, ID), backend)
})

test('the token depends on both the key and the participant', () => {
  assert.notEqual(checkinToken(KEY, ID), checkinToken(KEY.replace('0', '1'), ID))
  assert.notEqual(checkinToken(KEY, ID), checkinToken(KEY, ID.replace('7', '8')))
})

test('checkinUrl carries the participant and the token', () => {
  const url = new URL(checkinUrl({ slug: 'wilczy' }, ID, KEY))
  assert.equal(url.pathname, '/events/wilczy/checkin')
  assert.equal(url.searchParams.get('p'), ID)
  assert.equal(url.searchParams.get('t'), checkinToken(KEY, ID))
})

test('sameToken compares exactly', () => {
  assert.equal(sameToken('abc', 'abc'), true)
  assert.equal(sameToken('abc', 'abd'), false)
  assert.equal(sameToken('abc', 'ab'), false)
  assert.equal(sameToken(undefined, 'abc'), false)
})

test('generatePin is always six digits', () => {
  for (let i = 0; i < 1000; i++) assert.match(generatePin(), /^[1-9]\d{5}$/)
})
