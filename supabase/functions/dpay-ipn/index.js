import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { dpayConfig, verifyIpn } from '../_shared/dpay.js'
import { parseDpayAmount } from '../_shared/registration/money.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { logPaymentEvent, raiseAlert, settleConfirmOutcome } from '../_shared/registration/orderFlow.js'

// dpay's payment notification (IPN), https://docs.dpay.pl/docs/cykl-platnosci/obsluga-ipn/.
//
// dpay's server POSTs JSON { id, amount, email?, type, attempt, version, custom?, signature }
// with no Origin, so guardRequest lets it through. Authenticity is the signature alone
// (verifyIpn: sha256 over the fields and our secret), never the origin or the IP.
//
// dpay reads only the BODY: exactly `OK` means delivered, anything else is retried (up to 10
// times, 2^n minutes apart). So:
//   OK       the IPN is decided and that decision is committed (confirm_order is one
//            transaction), or there is nothing to decide (not a transfer, no such order:
//            alerted once per transaction). A replay of a handled IPN gets OK again and
//            changes nothing: confirm_order answers already_confirmed / already_handled, and
//            only the statement that moves an attempt created → paid can lead to an e-mail or
//            a refund (ruling 8).
//   INVALID  a body that is not a signed JSON object (400), or one over 8 KB (413). dpay will
//            retry it; it stays invalid.
//   ERROR    we could not decide (503 unconfigured, 500 a database error): dpay retries.
//
// Every IPN that is not oversized is written to payment_events BEFORE any decision, with
// checksum_ok and the payer address only as email_sha256 (redactDpay drops `email`). The log is
// best effort (logPaymentEvent alerts on failure) and never blocks a confirmation. Nothing here
// prints the raw body or the payer address to the console.
const MAX_BODY = 8 * 1024
const TEXT = { 'Content-Type': 'text/plain; charset=utf-8' }
const answer = (body, status) => new Response(body, { status, headers: TEXT })
const OK = () => answer('OK', 200)
const INVALID = (status = 400) => answer('INVALID', status)
const ERROR = (status = 500) => answer('ERROR', status)

const encoder = new TextEncoder()
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// The body as text, or null when it is longer than `max` bytes (read no further than that).
async function readCapped(req, max) {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  return new TextDecoder().decode(bytes)
}

const scalarText = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

// The IPN amount in grosze, or null when it is not dpay's decimal form (ruling 4).
function amountOf(v) {
  const text = scalarText(v)
  if (text === null) return null
  try {
    return parseDpayAmount(text)
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard
  if (req.method !== 'POST') return INVALID(405)

  let raw
  try {
    raw = await readCapped(req, MAX_BODY)
  } catch {
    return INVALID()
  }
  if (raw === null) return INVALID(413)

  let cfg
  try {
    cfg = dpayConfig(Deno.env)
  } catch (err) {
    console.error('dpay-ipn:', err?.message)
    return ERROR(503)
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body = null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
  } catch {
    // body stays null: logged as unparsable, answered INVALID
  }

  try {
    const checksumOk = body ? await verifyIpn(cfg, body) : false
    const txn = body ? scalarText(body.id) : null
    const custom = body?.custom

    // Which order and attempt the IPN names, only to link the log row; nothing is decided yet.
    let order = null
    let attemptId = null
    if (isUuid(custom)) {
      const { data, error } = await admin.from('orders').select('id').eq('id', custom.toLowerCase()).maybeSingle()
      if (error) throw error
      order = data
      if (order && txn) {
        const { data: attempt, error: aErr } = await admin.from('payment_attempts').select('id')
          .eq('order_id', order.id).eq('dpay_transaction_id', txn).maybeSingle()
        if (aErr) throw aErr
        attemptId = attempt?.id ?? null
      }
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    await logPaymentEvent(admin, {
      kind: 'ipn',
      orderId: order?.id ?? null,
      attemptId,
      payload: body ?? { unparsable: true, bytes: encoder.encode(raw).byteLength },
      emailSha256: email ? await sha256Hex(email) : null,
      checksumOk,
    })

    if (!body || !checksumOk) return INVALID()
    if (body.type !== 'transfer') return OK()

    // Money received that names no order of ours: a person has to find it. One alert per
    // transaction however often dpay retries (the key confirm_order uses for the same case).
    if (!order) {
      const stored = await raiseAlert(admin, 'unknown_attempt', null, {
        txn, custom: scalarText(custom), amount: scalarText(body.amount), source: 'ipn',
        reason: isUuid(custom) ? 'no_such_order' : 'custom_not_an_order_id',
      }, { dedupeKey: `unknown_attempt:${txn ?? ''}` })
      return stored ? OK() : ERROR()
    }

    // Ruling 6: an amount we cannot read never confirms and never refunds.
    const grosze = amountOf(body.amount)
    if (grosze === null) {
      const stored = await raiseAlert(admin, 'amount_mismatch', order.id, {
        attemptId, txn, amount: scalarText(body.amount), reason: 'unparsable_amount', source: 'ipn',
      }, { dedupeKey: `amount_mismatch:${txn}` })
      return stored ? OK() : ERROR()
    }

    const { data: outcome, error: rpcErr } = await admin.rpc('confirm_order', {
      p_order_id: order.id, p_txn: txn, p_grosze: grosze, p_source: 'ipn',
    })
    if (rpcErr) {
      console.error('dpay-ipn: confirm_order failed:', rpcErr.message, rpcErr.code)
      return ERROR()
    }
    // The decision is committed. What follows (the e-mail, a refund at dpay and its
    // settlement) never throws and is not repeated by a replay.
    await settleConfirmOutcome(admin, cfg, { ...outcome, orderId: order.id, txn })
    return OK()
  } catch (err) {
    console.error('dpay-ipn error:', err?.message, err?.code)
    return ERROR()
  }
})
