// P-06, P-07: dpay checksums and config. Expected digests are computed here with node:crypto over the
// concatenation written out by hand from the docs' formulas, never with the module under test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  registerChecksum,
  ipnSignature,
  detailsChecksum,
  refundChecksum,
  safeEqualHex,
} from '../../../supabase/functions/_shared/registration/dpaySign.js'
import { dpayConfig, DpayConfigError, verifyIpn } from '../../../supabase/functions/_shared/dpay.js'

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const cfg = { service: 'svc', secret: 'sec' }

test('P-06 register checksum: service|secret|value|url_success|url_fail|url_ipn', async () => {
  const got = await registerChecksum(cfg, {
    value: '100.91',
    urlSuccess: 'https://s.test/ok',
    urlFail: 'https://s.test/fail',
    urlIpn: 'https://s.test/ipn',
  })
  assert.equal(got, sha('svc|sec|100.91|https://s.test/ok|https://s.test/fail|https://s.test/ipn'))
})

test('P-06 register checksum without url_ipn keeps the trailing separator', async () => {
  const got = await registerChecksum(cfg, { value: '1.00', urlSuccess: 'a', urlFail: 'b' })
  assert.equal(got, sha('svc|sec|1.00|a|b|'))
  assert.equal(await registerChecksum(cfg, { value: '1.00', urlSuccess: 'a', urlFail: 'b', urlIpn: '' }), got)
})

test('P-06 details and refund checksums put the secret last', async () => {
  assert.equal(await detailsChecksum(cfg, 'T-1'), sha('svc|T-1|sec'))
  assert.equal(await refundChecksum(cfg, { transactionId: 'T-1' }), sha('svc|T-1|sec'))
  assert.equal(await refundChecksum(cfg, { transactionId: 'T-1', value: '10.00' }), sha('svc|T-1|10.00|sec'))
})

const ipn = {
  id: 'abc-def-123-456',
  amount: '29.99',
  email: 'klient@example.com',
  type: 'transfer',
  attempt: 1,
  version: 1,
  custom: 'order-789',
}

test('P-06 IPN signature concatenates without separators', async () => {
  assert.equal(await ipnSignature('sec', ipn), sha('abc-def-123-456sec29.99klient@example.comtransfer11order-789'))
})

test('P-06 IPN with no email key or no custom key concatenates an empty string', async () => {
  const { email, ...noEmail } = ipn
  assert.equal(await ipnSignature('sec', noEmail), sha('abc-def-123-456sec29.99transfer11order-789'))
  const { custom, ...noCustom } = ipn
  assert.equal(await ipnSignature('sec', noCustom), sha('abc-def-123-456sec29.99klient@example.comtransfer11'))
})

test('P-06 dcb IPN leaves email out of the formula', async () => {
  const dcb = { ...ipn, type: 'dcb' }
  assert.equal(await ipnSignature('sec', dcb), sha('abc-def-123-456sec29.99dcb11order-789'))
})

test('P-06 verifyIpn accepts a correct signature and refuses a flipped character in any field', async () => {
  const signed = { ...ipn, signature: await ipnSignature('sec', ipn) }
  assert.equal(await verifyIpn(cfg, signed), true)
  assert.equal(await verifyIpn(cfg, { ...signed, signature: signed.signature.toUpperCase() }), true)

  const flip = (v) => {
    const s = String(v)
    const last = s.at(-1)
    return s.slice(0, -1) + (last === '1' ? '2' : '1')
  }
  for (const key of ['id', 'amount', 'email', 'type', 'custom', 'signature']) {
    assert.equal(await verifyIpn(cfg, { ...signed, [key]: flip(signed[key]) }), false, key)
  }
  assert.equal(await verifyIpn(cfg, { ...signed, attempt: 2 }), false, 'attempt')
  assert.equal(await verifyIpn(cfg, { ...signed, version: 2 }), false, 'version')
  assert.equal(await verifyIpn({ ...cfg, secret: 'sed' }, signed), false, 'secret')
})

test('P-06 verifyIpn refuses a payload missing a required field or not an object', async () => {
  const signed = { ...ipn, signature: await ipnSignature('sec', ipn) }
  for (const key of ['id', 'amount', 'type', 'attempt', 'version', 'signature']) {
    const { [key]: _, ...rest } = signed
    assert.equal(await verifyIpn(cfg, rest), false, key)
  }
  assert.equal(await verifyIpn(cfg, null), false)
  assert.equal(await verifyIpn(cfg, 'x'), false)
  assert.equal(await verifyIpn(cfg, [signed]), false)
  assert.equal(await verifyIpn(cfg, { ...signed, amount: { v: 1 } }), false)
})

test('P-06 safeEqualHex compares equal-length strings only', () => {
  assert.equal(safeEqualHex('ab12', 'ab12'), true)
  assert.equal(safeEqualHex('ab12', 'ab13'), false)
  assert.equal(safeEqualHex('ab12', 'ab1'), false)
  assert.equal(safeEqualHex('ab12', null), false)
  assert.equal(safeEqualHex(undefined, undefined), false)
})

const fullEnv = {
  DPAY_SERVICE: 'mock-service',
  DPAY_SECRET: 'mock-secret',
  DPAY_API_BASE: 'http://127.0.0.1:54398/',
  DPAY_PANEL_BASE: 'http://127.0.0.1:54398',
  DPAY_IPN_URL: 'http://127.0.0.1:54321/functions/v1/dpay-ipn',
  PUBLIC_SITE_URL: 'http://localhost:5173/',
}

test('P-07 dpayConfig({}) throws naming every missing key, DPAY_SECRET included', () => {
  assert.throws(() => dpayConfig({}), (err) => {
    assert.ok(err instanceof DpayConfigError)
    assert.match(err.message, /DPAY_SECRET/)
    assert.ok(err.missing.includes('DPAY_SECRET'))
    assert.equal(err.missing.length, 6)
    return true
  })
  const { DPAY_SECRET, ...noSecret } = fullEnv
  assert.throws(() => dpayConfig(noSecret), { name: 'DpayConfigError', message: /DPAY_SECRET/ })
  assert.throws(() => dpayConfig({ ...fullEnv, DPAY_SECRET: '' }), { message: /DPAY_SECRET/ })
  assert.throws(() => dpayConfig({ ...fullEnv, DPAY_API_BASE: 'not a url' }), { message: /DPAY_API_BASE/ })
})

test('P-07 dpayConfig reads a plain object or a Deno.env-like getter and trims trailing slashes', () => {
  const cfgA = dpayConfig(fullEnv)
  assert.deepEqual(cfgA, {
    service: 'mock-service',
    secret: 'mock-secret',
    apiBase: 'http://127.0.0.1:54398',
    panelBase: 'http://127.0.0.1:54398',
    ipnUrl: 'http://127.0.0.1:54321/functions/v1/dpay-ipn',
    publicSiteUrl: 'http://localhost:5173',
    timeoutMs: 10_000,
  })
  const cfgB = dpayConfig({ get: (k) => fullEnv[k] })
  assert.deepEqual(cfgB, cfgA)
})
