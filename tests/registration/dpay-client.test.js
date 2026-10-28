// P-08, P-09: the dpay client against the mocked dpay server. Needs no Supabase stack: the mock is
// started in this process unless one already listens on 54398 (CI starts it beside the email capture).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  dpayConfig,
  DpayError,
  registerTransaction,
  verifyIpn,
  transactionDetails,
  refundTransaction,
} from '../../supabase/functions/_shared/dpay.js'
import { startDpayMock, DPAY_MOCK_PORT, MOCK_SERVICE, MOCK_SECRET } from './helpers/dpayMock.js'
import {
  dpayReset,
  dpayMode,
  dpayTransactions,
  dpayIpns,
  dpayRefunds,
  payMock,
  replayIpn,
} from './helpers/dpayControl.js'

const ORDER = '7f3c0b52-9a51-4d7e-9f0e-2a4c1b6d8e10'
const MOCK = `http://127.0.0.1:${DPAY_MOCK_PORT}`

let stopMock
let receiver
let received = []
let answers = [] // bodies the IPN receiver answers with, in order; then 'OK'
let cfg

before(async () => {
  stopMock = await startDpayMock()
  receiver = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      received.push({ headers: req.headers, raw })
      res.end(answers.length ? answers.shift() : 'OK')
    })
  })
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r))
  cfg = dpayConfig({
    DPAY_SERVICE: MOCK_SERVICE,
    DPAY_SECRET: MOCK_SECRET,
    DPAY_API_BASE: MOCK,
    DPAY_PANEL_BASE: MOCK,
    DPAY_IPN_URL: `http://127.0.0.1:${receiver.address().port}/ipn`,
    PUBLIC_SITE_URL: 'http://localhost:5173',
  })
})

after(async () => {
  await dpayReset()
  receiver.closeAllConnections?.()
  await new Promise((r) => receiver.close(r))
  if (stopMock) await stopMock()
})

beforeEach(async () => {
  await dpayReset()
  received = []
  answers = []
})

async function paidTransaction(grosze = 10091) {
  const { transactionId } = await registerTransaction(cfg, { orderId: ORDER, grosze })
  await payMock(transactionId, 'paid')
  return transactionId
}

test('P-08 register → transactionId, redirect to the mock pay page, no channel, custom = orderId', async () => {
  const { transactionId, redirectUrl } = await registerTransaction(cfg, { orderId: ORDER, grosze: 10091 })
  assert.match(transactionId, /\S/)
  assert.match(redirectUrl, new RegExp(`/pay/${transactionId}$`))

  const [txn] = await dpayTransactions()
  assert.equal(txn.id, transactionId)
  assert.equal(txn.request.custom, ORDER)
  assert.equal(txn.request.value, '100.91')
  assert.equal(txn.request.transactionType, 'transfers')
  assert.equal(txn.request.url_success, `http://localhost:5173/zamowienie/${ORDER}`)
  assert.equal(txn.request.url_fail, `http://localhost:5173/zamowienie/${ORDER}`)
  assert.equal(txn.request.url_ipn, cfg.ipnUrl)
  assert.equal('channel' in txn.request, false)

  const page = await fetch(redirectUrl)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /Zapłać \(mock\)/)
  assert.match(html, /Odrzuć \(mock\)/)
})

test('P-08 register failure (HTTP 500) → DpayError(500)', async () => {
  await dpayMode({ registerFails: true })
  await assert.rejects(registerTransaction(cfg, { orderId: ORDER, grosze: 1000 }), (err) => {
    assert.ok(err instanceof DpayError)
    assert.equal(err.httpStatus, 500)
    return true
  })
})

test('P-08 HTTP 200 with error:true → DpayError(200), never a redirect', async () => {
  await dpayMode({ registerErrorBody: true })
  await assert.rejects(registerTransaction(cfg, { orderId: ORDER, grosze: 1000 }), (err) => {
    assert.ok(err instanceof DpayError)
    assert.equal(err.httpStatus, 200)
    assert.equal(err.redirectUrl, undefined)
    return true
  })
})

test('P-08 a wrong secret is refused by the mock with 401', async () => {
  await assert.rejects(registerTransaction({ ...cfg, secret: 'nope' }, { orderId: ORDER, grosze: 1000 }), {
    name: 'DpayError',
    httpStatus: 401,
  })
})

test('mock: channel without payer data → 422', async () => {
  const res = await fetch(`${MOCK}/api/v1_0/payments/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: MOCK_SERVICE, transactionType: 'transfers', value: '1.00', url_success: 'a', url_fail: 'b', channel: 1, checksum: 'x' }),
  })
  assert.equal(res.status, 422)
})

test('mock: paying delivers a signed IPN that verifyIpn accepts, retried until the body is OK', async () => {
  answers = ['NOPE', 'still no']
  const txnId = await paidTransaction(10091)
  assert.equal(received.length, 3)
  const body = JSON.parse(received[2].raw)
  assert.equal(body.id, txnId)
  assert.equal(body.amount, '100.91')
  assert.equal(body.type, 'transfer')
  assert.equal(body.custom, ORDER)
  assert.equal(await verifyIpn(cfg, body), true)
  const ipns = await dpayIpns()
  assert.deepEqual(ipns.map((i) => i.responseText), ['NOPE', 'still no', 'OK'])
})

test('mock: modes ipnWithoutEmail, corruptSignature, duplicateIpn, ipnAmountOverride, dropIpn, replay', async () => {
  await dpayMode({ ipnWithoutEmail: true, ipnAmountOverride: '100.9' })
  await paidTransaction()
  const plain = JSON.parse(received.at(-1).raw)
  assert.equal('email' in plain, false)
  assert.equal(plain.amount, '100.9')
  assert.equal(await verifyIpn(cfg, plain), true)

  await dpayMode({ ipnWithoutEmail: false, ipnAmountOverride: null, corruptSignature: true })
  await paidTransaction()
  assert.equal(await verifyIpn(cfg, JSON.parse(received.at(-1).raw)), false)

  await dpayReset()
  received = []
  await dpayMode({ duplicateIpn: true })
  const dup = await paidTransaction()
  assert.equal(received.length, 2)
  assert.equal(received[0].raw, received[1].raw)
  await replayIpn(dup, { times: 2 })
  assert.equal(received.length, 4)

  await dpayReset()
  received = []
  await dpayMode({ dropIpn: true })
  await paidTransaction()
  assert.equal(received.length, 0)
})

test('mock: declined payment sends no IPN and the pay page redirects to url_fail', async () => {
  const { transactionId, redirectUrl } = await registerTransaction(cfg, { orderId: ORDER, grosze: 1000 })
  const res = await fetch(`${redirectUrl}/declined`, { method: 'POST', redirect: 'manual' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), `http://localhost:5173/zamowienie/${ORDER}`)
  assert.equal(received.length, 0)
  assert.equal((await transactionDetails(cfg, transactionId)).status, 'expired')
})

test('P-09 details: status and grosze; detailsStatus override; unrecognised amount → grosze null', async () => {
  const { transactionId } = await registerTransaction(cfg, { orderId: ORDER, grosze: 10091 })
  assert.deepEqual(
    (({ status, grosze }) => ({ status, grosze }))(await transactionDetails(cfg, transactionId)),
    { status: 'created', grosze: 10091 },
  )
  await payMock(transactionId, 'paid')
  const paid = await transactionDetails(cfg, transactionId)
  assert.equal(paid.status, 'paid')
  assert.equal(paid.grosze, 10091)
  assert.ok(paid.raw)

  await dpayMode({ detailsStatus: 'processing' })
  assert.equal((await transactionDetails(cfg, transactionId)).status, 'processing')

  for (const body of [
    { transaction: { id: transactionId, status: 'paid', amount: '100.91' } },
    { transaction: { id: transactionId, status: 'paid', value: '100,91' } },
    { transaction: { id: transactionId, status: 'paid', value: 100.911 } },
    { status: 'paid', value: '100.91' },
  ]) {
    await dpayMode({ detailsStatus: null, detailsBodyOverride: body })
    const d = await transactionDetails(cfg, transactionId)
    assert.equal(d.grosze, null, JSON.stringify(body))
  }
  await dpayMode({ detailsBodyOverride: { transaction: { status: 'weird', value: '1.00' } } })
  assert.equal((await transactionDetails(cfg, transactionId)).status, null)
})

test('P-09 details of an unknown transaction → DpayError(404)', async () => {
  await assert.rejects(transactionDetails(cfg, 'no-such-txn'), { name: 'DpayError', httpStatus: 404 })
})

test('P-09 refunds: partial 1000 twice accepted, over the rest rejected 400, unpaid 402, full then 410', async () => {
  const txnId = await paidTransaction(10091)
  const a = await refundTransaction(cfg, { transactionId: txnId, grosze: 1000, messageId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
  assert.deepEqual([a.outcome, a.httpStatus], ['accepted', 200])
  const b = await refundTransaction(cfg, { transactionId: txnId, grosze: 1000, messageId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
  assert.deepEqual([b.outcome, b.httpStatus], ['accepted', 200], 'the mock does not deduplicate on the message id')
  const over = await refundTransaction(cfg, { transactionId: txnId, grosze: 9000, messageId: 'b' })
  assert.deepEqual([over.outcome, over.httpStatus], ['rejected', 400])
  const rest = await refundTransaction(cfg, { transactionId: txnId, messageId: 'c' })
  assert.deepEqual([rest.outcome, rest.httpStatus], ['accepted', 200])
  const again = await refundTransaction(cfg, { transactionId: txnId, grosze: 1, messageId: 'd' })
  assert.deepEqual([again.outcome, again.httpStatus], ['rejected', 410])

  const refunds = await dpayRefunds()
  assert.deepEqual(refunds.map((r) => [r.grosze, r.messageId]), [
    [1000, 'aaaaaaaaaaaaaaaaaaaaaaaa'],
    [1000, 'aaaaaaaaaaaaaaaaaaaaaaaa'],
    [8091, 'c'],
  ])

  const { transactionId: unpaid } = await registerTransaction(cfg, { orderId: ORDER, grosze: 1000 })
  const u = await refundTransaction(cfg, { transactionId: unpaid, messageId: 'e' })
  assert.deepEqual([u.outcome, u.httpStatus], ['rejected', 402])
})

test('P-09 refund outcomes: 406 insufficient_balance, 500 unknown, hang unknown after the timeout', async () => {
  const txnId = await paidTransaction(5000)
  await dpayMode({ refundInsufficient: true })
  const ins = await refundTransaction(cfg, { transactionId: txnId, grosze: 100, messageId: 'x' })
  assert.deepEqual([ins.outcome, ins.httpStatus], ['insufficient_balance', 406])

  await dpayMode({ refundInsufficient: false, refundFails: true })
  const fail = await refundTransaction(cfg, { transactionId: txnId, grosze: 100, messageId: 'x' })
  assert.deepEqual([fail.outcome, fail.httpStatus], ['unknown', 500])

  await dpayMode({ refundFails: false, refundHang: true })
  const started = Date.now()
  const hang = await refundTransaction({ ...cfg, timeoutMs: 300 }, { transactionId: txnId, grosze: 100, messageId: 'x' })
  assert.deepEqual([hang.outcome, hang.httpStatus], ['unknown', null])
  assert.ok(Date.now() - started < 3000)
  assert.equal((await dpayRefunds()).length, 0)
})

test('refund with a messageId over 24 characters is refused before any call', async () => {
  await assert.rejects(
    refundTransaction(cfg, { transactionId: 't', messageId: 'x'.repeat(25) }),
    /messageId/,
  )
})
