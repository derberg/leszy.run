// Runs the REAL app code (dpay.js, money.js, the order RPC helpers) in plain Node for the Playwright spec.
// Playwright's loader reads supabase/functions/_shared/registration/money.js as CommonJS (no package
// "type"), so the spec cannot import it; a child process can. One JSON request on stdin, one JSON answer
// on stdout: node bridge.mjs <op> < request.json
import { sandboxConfig } from './guard.js'
import { dpayConfig, registerTransaction, refundTransaction, transactionDetails } from '../../../supabase/functions/_shared/dpay.js'
import { parseDpayAmount } from '../../../supabase/functions/_shared/registration/money.js'

const [op] = process.argv.slice(2)
const req = JSON.parse(await new Promise((res) => { let s = ''; process.stdin.on('data', (c) => { s += c }).on('end', () => res(s || '{}')) }))

function cfg(over = {}) {
  const c = sandboxConfig()
  return dpayConfig({
    DPAY_SERVICE: c.service, DPAY_SECRET: c.secret, DPAY_API_BASE: c.apiBase, DPAY_PANEL_BASE: c.panelBase,
    DPAY_IPN_URL: over.ipnUrl ?? c.ipnUrl, PUBLIC_SITE_URL: 'http://localhost:5173',
  })
}

const ops = {
  parse: async ({ str }) => { try { return { grosze: parseDpayAmount(str) } } catch (e) { return { error: e.message } } },
  total: async ({ price, n = 1, support = false }) => (await import('../helpers/orders.js')).totalFor(price, n, support),
  details: ({ txn }) => transactionDetails(cfg(), txn),
  refund: ({ txn, grosze, messageId }) => refundTransaction(cfg(), { transactionId: txn, grosze, messageId }),
  // An order whose dpay transaction was registered with an unreachable IPN URL (S-05).
  brokenIpnOrder: async ({ event, email, price }) => {
    const o = await import('../helpers/orders.js')
    const created = await o.orderOk(event, { emails: [email], price })
    const orderId = created.orderId ?? created.order_id ?? created.id
    if (!orderId) throw new Error(`create_order result keys: ${Object.keys(created)}`)
    const total = o.totalFor(price, 1, false)
    const reg = await registerTransaction(cfg({ ipnUrl: 'https://ipn-unreachable.invalid/dpay-ipn' }), { orderId, grosze: total })
    await o.attemptFor(orderId, total, reg.transactionId)
    return { orderId, redirectUrl: reg.redirectUrl, transactionId: reg.transactionId }
  },
}
if (!ops[op]) throw new Error(`unknown op ${op}`)
try {
  console.log(JSON.stringify({ ok: await ops[op](req) }))
} catch (e) {
  console.log(JSON.stringify({ err: { name: e.name, message: e.message, httpStatus: e.httpStatus ?? e.status ?? null } }))
}
process.exit(0)
