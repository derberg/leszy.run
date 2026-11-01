import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDpayHttpsUrl, isTestService, sandboxConfig, shapeOf, SANDBOX_ENV_KEYS } from './guard.js'

const env = (over = {}) => ({
  ...Object.fromEntries(SANDBOX_ENV_KEYS.map((k) => [k, 'x'])),
  DPAY_SANDBOX_SERVICE: 'leszyrun-sandbox',
  DPAY_SANDBOX_API_BASE: 'https://api-payments.dpay.pl/', DPAY_SANDBOX_PANEL_BASE: 'https://panel.dpay.pl',
  SANDBOX_PUBLIC_IPN_URL: 'https://abc.trycloudflare.com/functions/v1/dpay-ipn', ...over,
})

test('S-00 only a service named as a test service passes', () => {
  assert.equal(isTestService('leszyrun-sandbox'), true)
  assert.equal(isTestService('LeszyRun-TEST'), true)
  assert.equal(isTestService('LESZY.RUN'), false)
  assert.equal(isTestService('leszyrun'), false)
  assert.equal(sandboxConfig(env()).service, 'leszyrun-sandbox')
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_SERVICE: 'LESZY.RUN' })), /DPAY_SANDBOX_SERVICE/)
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_SERVICE: 'leszyrun' })), /DPAY_SANDBOX_SERVICE/)
})

test('S-00 base URLs must be https on a dpay.pl host; the production hosts are accepted', () => {
  assert.equal(isDpayHttpsUrl('https://api-payments.dpay.pl'), true)
  assert.equal(isDpayHttpsUrl('https://PANEL.dpay.pl/'), true)
  assert.equal(isDpayHttpsUrl('http://panel.dpay.pl'), false)
  assert.equal(isDpayHttpsUrl('https://dpay.pl.evil.example'), false)
  assert.equal(isDpayHttpsUrl('https://evildpay.pl'), false)
  assert.equal(isDpayHttpsUrl('not a url'), false)
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_PANEL_BASE: 'http://panel.dpay.pl' })), /DPAY_SANDBOX_PANEL_BASE is not an https URL/)
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_API_BASE: 'https://api.example.com' })), /DPAY_SANDBOX_API_BASE is not an https URL on a dpay.pl host/)
})

test('S-00 sandboxConfig refuses incomplete env and trims slashes', () => {
  assert.throws(() => sandboxConfig(env({ DPAY_SANDBOX_SECRET: ' ' })), /missing DPAY_SANDBOX_SECRET/)
  const cfg = sandboxConfig(env())
  assert.equal(cfg.apiBase, 'https://api-payments.dpay.pl')
  assert.equal(cfg.panelBase, 'https://panel.dpay.pl')
})

test('S-00 shapeOf keeps keys and drops every value', () => {
  const shape = shapeOf({ a: 'secret', n: 5, ok: true, nested: { e: 'a@b.pl' }, list: [{ k: 'v' }, { k: 'w' }], z: null })
  assert.deepEqual(shape, { a: '<string:6>', n: '<number>', ok: '<boolean>', nested: { e: '<string:6>' }, list: [{ k: '<string:1>' }, '... x2'], z: null })
  assert.ok(!JSON.stringify(shape).includes('secret'))
})
