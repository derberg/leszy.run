// Mocked dpay for the local test stack. Never talks to real dpay. The edge functions reach it through
// DPAY_API_BASE / DPAY_PANEL_BASE (tests/registration/functions.env), tests through dpayControl.js.
// It checks every checksum with its own node:crypto code, written from the dpay docs, so it never trusts
// the signing module under test.
//
//   POST /api/v1_0/payments/register   docs.dpay.pl/docs/cykl-platnosci/rejestracja-transakcji/
//   GET  /pay/:txn                     stand-in for dpay's gateway page: „Zapłać (mock)” / „Odrzuć (mock)”
//   POST /pay/:txn/paid|declined       pays (signed IPN to url_ipn) or declines, then 303 to url_success/url_fail
//   POST /api/v1/pbl/details           docs.dpay.pl/docs/cykl-platnosci/statusy-transakcji/
//   POST /api/v1/pbl/refund            docs.dpay.pl/docs/cykl-platnosci/zwroty/
//   /__control/*                       reset, mode, state, pay, replay (see dpayControl.js)
//
// IPN: docs.dpay.pl/docs/cykl-platnosci/obsluga-ipn/. Delivered when the response body, trimmed, is
// `OK` (the HTTP status is ignored); otherwise retried, 3 quick retries here instead of dpay's 2^n
// minutes. Refunds are NOT deduplicated on DigitalPayments-PSP-Message-ID: dpay does not document that
// it does, so a second identical call refunds again, and our own idempotency has to hold.
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DPAY_MOCK_BASE_PORT, slotPort } from './slot.js'

// 54398 in slot 0, 54398 + n x 100 in slot n (REG_TEST_SLOT).
export const DPAY_MOCK_PORT = slotPort(DPAY_MOCK_BASE_PORT)
export const MOCK_SERVICE = 'mock-service'
export const MOCK_SECRET = 'mock-secret'
const IPN_RETRIES = 3
const IPN_RETRY_MS = 50
const PAYER_EMAIL = 'payer@mock.test'

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

// '12.34' / '12.3' / '12' → grosze; anything else → null.
function toGrosze(v) {
  const m = typeof v === 'string' ? /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(v) : null
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null
}
const toValue = (g) => `${Math.floor(g / 100)}.${String(g % 100).padStart(2, '0')}`

// PBL API checksum: every body value except checksum, in JSON order, joined by '|', then the secret.
function orderedChecksum(body) {
  const parts = Object.entries(body)
    .filter(([k]) => k !== 'checksum')
    .map(([, v]) => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
  return sha(`${parts.join('|')}|${MOCK_SECRET}`)
}

function ipnSign(ipn) {
  const s = (v) => (v === undefined || v === null ? '' : String(v))
  const parts = [s(ipn.id), MOCK_SECRET, s(ipn.amount)]
  if (ipn.type !== 'dcb') parts.push(s(ipn.email))
  parts.push(s(ipn.type), s(ipn.attempt), s(ipn.version), s(ipn.custom))
  return sha(parts.join(''))
}

const DEFAULT_MODE = {
  registerFails: false,
  registerErrorBody: false,
  ipnDelayMs: 0,
  dropIpn: false,
  corruptSignature: false,
  duplicateIpn: false,
  ipnAmountOverride: null,
  ipnWithoutEmail: false,
  detailsStatus: null,
  detailsBodyOverride: null,
  refundFails: false,
  refundInsufficient: false,
  refundPending: false,
  refundRejected: false,
  refundBodyOverride: null,
  refundHang: false,
  detailsHang: false,
}

function listening(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__control/transactions', timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => resolve(raw))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function postIpn(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    return await res.text()
  } catch {
    return null
  }
}

/**
 * Starts the mock in this process. Resolves to a stop function, or null when one already listens.
 * `publicUrl` is the base of the pay-page links handed to the browser.
 */
export async function startDpayMock({ port = DPAY_MOCK_PORT, publicUrl = `http://localhost:${port}` } = {}) {
  if (await listening(port)) return null

  let mode = { ...DEFAULT_MODE }
  const txns = new Map() // id → { id, request, grosze, status, refunded, ipn, createdAt }
  let ipns = []
  let refunds = []
  const hanging = new Set()
  const timers = new Set()

  function ipnBodyFor(txn) {
    const ipn = { id: txn.id, amount: mode.ipnAmountOverride ?? toValue(txn.grosze) }
    if (!mode.ipnWithoutEmail) ipn.email = PAYER_EMAIL
    ipn.type = 'transfer'
    ipn.attempt = 1
    ipn.version = 1
    if (typeof txn.request.custom === 'string') ipn.custom = txn.request.custom
    let signature = ipnSign(ipn)
    if (mode.corruptSignature) signature = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
    return JSON.stringify({ ...ipn, signature })
  }

  // One delivery: the first try plus up to IPN_RETRIES retries while the body is not OK.
  async function deliver(txn, body) {
    const url = txn.request.url_ipn
    if (!url) return
    for (let i = 0; i <= IPN_RETRIES; i++) {
      if (i > 0) await sleep(IPN_RETRY_MS)
      const responseText = await postIpn(url, body)
      ipns.push({ txnId: txn.id, body: JSON.parse(body), responseText, at: new Date().toISOString() })
      if (responseText !== null && responseText.trim() === 'OK') return
    }
  }

  async function sendIpns(txn) {
    if (mode.dropIpn) return
    const body = ipnBodyFor(txn)
    txn.ipn = body
    // duplicateIpn: true → the same IPN twice, one after the other; a number n → n deliveries
    // at the same moment (each still retried until OK), the way overlapping dpay retries land.
    const run = async () => {
      if (Number.isInteger(mode.duplicateIpn) && mode.duplicateIpn > 1) {
        await Promise.all(Array.from({ length: mode.duplicateIpn }, () => deliver(txn, body)))
        return
      }
      for (let i = 0; i < (mode.duplicateIpn ? 2 : 1); i++) await deliver(txn, body)
    }
    if (mode.ipnDelayMs > 0) {
      const t = setTimeout(() => { timers.delete(t); run() }, mode.ipnDelayMs)
      timers.add(t)
    } else {
      await run()
    }
  }

  // 'paid' → status paid + IPN; 'declined' → expired, no IPN (dpay sends IPNs for payments only).
  async function settle(txnId, outcome) {
    const txn = txns.get(txnId)
    if (!txn) return { status: 404, error: 'unknown transaction' }
    if (txn.status !== 'created') return { status: 409, error: `transaction is ${txn.status}` }
    if (outcome === 'paid') {
      txn.status = 'paid'
      await sendIpns(txn)
    } else if (outcome === 'declined') {
      txn.status = 'expired'
    } else return { status: 400, error: 'outcome must be paid or declined' }
    return { status: 200, txn }
  }

  function register(body) {
    if (mode.registerFails) return [500, { error: true, status: false, msg: 'Mock internal error' }]
    if (mode.registerErrorBody) {
      return [200, { error: true, status: false, msg: 'Transaction error', additionalInfo: { error: 'mock', error_description: 'registerErrorBody' } }]
    }
    const required = ['service', 'transactionType', 'value', 'url_success', 'url_fail', 'checksum']
    if (body.channel !== undefined) required.push('email', 'client_name', 'client_surname', 'accept_tos')
    const errors = {}
    for (const k of required) if (body[k] === undefined || body[k] === null || body[k] === '') errors[k] = ['The field is required.']
    const grosze = toGrosze(body.value)
    if (body.value !== undefined && (grosze === null || grosze === 0)) errors.value = ['Invalid value.']
    if (Object.keys(errors).length) return [422, { message: 'The given data was invalid.', errors }]
    // A merchant error is HTTP 400 with status 'failed' (rejestracja-transakcji, "Merchant error").
    if (body.service !== MOCK_SERVICE) return [400, { status: 'failed', message: 'Unknown service', errors: {} }]
    const expected = sha([body.service, MOCK_SECRET, toValue(grosze), body.url_success, body.url_fail, body.url_ipn ?? ''].join('|'))
    if (body.checksum !== expected) return [400, { status: 'failed', message: 'Invalid checksum', errors: {} }]
    const id = randomUUID().toUpperCase()
    txns.set(id, { id, request: body, grosze, status: 'created', refunded: 0, ipn: null, createdAt: new Date().toISOString() })
    return [200, { error: false, status: true, msg: `${publicUrl}/pay/${id}`, transactionId: id }]
  }

  function signedPbl(body) {
    if (!body || body.service !== MOCK_SERVICE || body.checksum !== orderedChecksum(body)) return false
    return true
  }

  function details(body) {
    if (!signedPbl(body)) return [401, { status: 'error', message: 'Unauthorized request' }]
    const txn = txns.get(body.transaction_id)
    if (!txn) return [404, 'Transaction not found']
    if (mode.detailsBodyOverride) return [200, mode.detailsBodyOverride]
    // Shape after the official Node SDK's parser (@dpayglobal/dpay-node-sdk 0.2.0); dpay's docs do not
    // list the fields. Sandbox test S-06 records the real one.
    return [200, {
      transaction: {
        id: txn.id,
        value: toValue(txn.grosze),
        status: mode.detailsStatus ?? txn.status,
        refunded: txn.refunded > 0,
        refunded_amount: toValue(txn.refunded),
        available_refund_amount: toValue(txn.grosze - txn.refunded),
        fully_refunded: txn.refunded === txn.grosze,
        creation_date: txn.createdAt,
      },
      refunds: refunds.filter((r) => r.txnId === txn.id).map((r) => ({ value: toValue(r.grosze), creation_date: r.at })),
      payer: {},
    }]
  }

  function refund(body, messageId) {
    if (mode.refundFails) return [500, { status: 'error', refund: false, message: 'Refund failed' }]
    if (!signedPbl(body)) return [401, { status: 'error', refund: false, message: 'Unauthorized request' }]
    if (mode.refundBodyOverride) return [200, mode.refundBodyOverride] // HTTP 200 with this body, nothing refunded
    const txn = txns.get(body.transaction_id)
    if (!txn) return [404, 'Transaction does not exist']
    if (txn.status !== 'paid') return [402, { status: 'error', refund: false, message: 'Transaction has not been paid' }]
    const remaining = txn.grosze - txn.refunded
    if (remaining === 0) return [410, { status: 'error', refund: false, message: 'Transaction has already been refunded' }]
    // 409: a refund form for this transaction was already submitted and is still being processed
    // (the official Node SDK lists 409 among the refund outcomes; the docs page does not describe it).
    if (mode.refundPending) return [409, { status: 'error', refund: false, message: 'Refund already in progress' }]
    // Any other 4xx, here a refusal (400): the client reads it as rejected, final.
    if (mode.refundRejected) return [400, { status: 'error', refund: false, message: 'Refund refused' }]
    if (mode.refundInsufficient) return [406, { status: 'error', refund: false, message: 'Insufficient balance to process the refund' }]
    const grosze = body.value === undefined ? remaining : toGrosze(body.value)
    if (grosze === null || grosze === 0) return [400, { status: 'error', refund: false, message: 'Invalid refund amount' }]
    if (grosze > remaining) return [400, { status: 'error', refund: false, message: 'Refund amount exceeds available refund amount' }]
    txn.refunded += grosze
    refunds.push({ txnId: txn.id, grosze, messageId: messageId ?? null, at: new Date().toISOString() })
    return [200, { status: 'success', refund: true, message: messageId ? `dpay.pl zwrot ${messageId}` : `dpay.pl ${txn.id}` }]
  }

  function payPage(txn) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>dpay (mock)</title></head><body>
<h1>dpay (mock)</h1><p>Kwota: <span data-testid="amount">${esc(toValue(txn.grosze))}</span> zł</p>
<form method="post" action="/pay/${esc(txn.id)}/paid"><button type="submit">Zapłać (mock)</button></form>
<form method="post" action="/pay/${esc(txn.id)}/declined"><button type="submit">Odrzuć (mock)</button></form>
</body></html>`
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    const send = (status, body) => {
      if (res.headersSent) return
      if (typeof body === 'string') {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(body)
      } else {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
    }
    const raw = req.method === 'POST' ? await readBody(req) : ''
    let json = null
    if (raw) {
      try { json = JSON.parse(raw) } catch { json = null }
    }

    try {
      if (req.method === 'POST' && path === '/api/v1_0/payments/register') {
        if (!json) return send(400, { status: 'failed', message: 'Invalid JSON', errors: {} })
        return send(...register(json))
      }
      if (req.method === 'POST' && path === '/api/v1/pbl/details') {
        if (mode.detailsHang) {
          hanging.add(res)
          req.on('close', () => hanging.delete(res))
          return
        }
        return send(...details(json))
      }
      if (req.method === 'POST' && path === '/api/v1/pbl/refund') {
        if (mode.refundHang) {
          hanging.add(res)
          req.on('close', () => hanging.delete(res))
          return
        }
        return send(...refund(json, req.headers['digitalpayments-psp-message-id']))
      }

      const pay = /^\/pay\/([^/]+)(?:\/(paid|declined))?$/.exec(path)
      if (pay) {
        const txn = txns.get(pay[1])
        if (!txn) return send(404, 'Unknown transaction')
        if (req.method === 'GET' && !pay[2]) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          return res.end(payPage(txn))
        }
        if (req.method === 'POST' && pay[2]) {
          const r = await settle(txn.id, pay[2])
          if (r.status !== 200) return send(r.status, r.error)
          res.writeHead(303, { location: pay[2] === 'paid' ? txn.request.url_success : txn.request.url_fail })
          return res.end()
        }
      }

      if (path.startsWith('/__control/')) {
        const op = path.slice('/__control/'.length)
        if (req.method === 'POST' && op === 'reset') {
          mode = { ...DEFAULT_MODE }
          txns.clear()
          ipns = []
          refunds = []
          for (const t of timers) clearTimeout(t)
          timers.clear()
          for (const r of hanging) r.destroy()
          hanging.clear()
          return send(200, { ok: true })
        }
        if (req.method === 'POST' && op === 'mode') {
          for (const [k, v] of Object.entries(json ?? {})) {
            if (!(k in DEFAULT_MODE)) return send(400, { error: `unknown mode ${k}` })
            mode[k] = v
          }
          return send(200, { data: mode })
        }
        if (req.method === 'GET' && op === 'transactions') return send(200, { data: [...txns.values()] })
        if (req.method === 'GET' && op === 'ipns') return send(200, { data: ipns })
        if (req.method === 'GET' && op === 'refunds') return send(200, { data: refunds })
        if (req.method === 'POST' && op === 'pay') {
          const r = await settle(json?.txnId, json?.outcome)
          return r.status === 200 ? send(200, { ok: true }) : send(r.status, { error: r.error })
        }
        if (req.method === 'POST' && op === 'replay') {
          const txn = txns.get(json?.txnId)
          if (!txn?.ipn) return send(409, { error: 'no IPN to replay' })
          for (let i = 0; i < (json.times ?? 1); i++) await deliver(txn, txn.ipn)
          return send(200, { ok: true })
        }
      }
      send(404, { error: 'not found' })
    } catch (err) {
      send(500, { error: String(err?.message ?? err) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })
  return () => new Promise((resolve) => {
    for (const t of timers) clearTimeout(t)
    for (const r of hanging) r.destroy()
    server.closeAllConnections?.()
    server.close(resolve)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = await startDpayMock({ publicUrl: process.env.DPAY_MOCK_PUBLIC_URL })
  if (stop) console.log(`dpay mock listening on :${DPAY_MOCK_PORT}`)
  else console.log('dpay mock already running')
}
