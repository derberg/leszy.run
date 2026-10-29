import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProductionDpayHost, sandboxConfig, shapeOf, SANDBOX_ENV_KEYS } from './guard.js'

const env = (over = {}) => ({
  ...Object.fromEntries(SANDBOX_ENV_KEYS.map((k) => [k, 'x'])),
  DPAY_SANDBOX_API_BASE: 'https://secure.sandbox.dpay.pl/', DPAY_SANDBOX_PANEL_BASE: 'https://panel.sandbox.dpay.pl',
  SANDBOX_PUBLIC_IPN_URL: 'https://abc.trycloudflare.com/functions/v1/dpay-ipn', ...over,
})

test('S-00 production dpay hosts are refused, sandbox hosts pass', () => {
  assert.equal(isProductionDpayHost('https://secure.dpay.pl/api'), true)
  assert.equal(isProductionDpayHost('https://PANEL.dpay.pl'), true)
  assert.equal(isProductionDpayHost('not a url'), true)
  assert.equal(isProductionDpayHost('https://secure.sandbox.dpay.pl'), false)
})

test('S-00 sandboxConfig refuses a production base URL and incomplete env, and trims slashes', () => {
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_API_BASE: 'https://secure.dpay.pl' })), /production dpay host/)
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_PANEL_BASE: 'https://panel.dpay.pl/' })), /production dpay host/)
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_SECRET: ' ' })), /missing DPAY_SANDBOX_SECRET/)
  assert.equal(sandboxConfig(env()).apiBase, 'https://secure.sandbox.dpay.pl')
})

test('S-00 shapeOf keeps keys and drops every value', () => {
  const shape = shapeOf({ a: 'secret', n: 5, ok: true, nested: { e: 'a@b.pl' }, list: [{ k: 'v' }, { k: 'w' }], z: null })
  assert.deepEqual(shape, { a: '<string:6>', n: '<number>', ok: '<boolean>', nested: { e: '<string:6>' }, list: [{ k: '<string:1>' }, '... x2'], z: null })
  assert.ok(!JSON.stringify(shape).includes('secret'))
})
