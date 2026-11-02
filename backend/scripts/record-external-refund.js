// Usage: cd backend && node --env-file=../.env scripts/record-external-refund.js \
//          (--order <order id> | --email <buyer e-mail> --event <event slug>) --amount <zł> \
//          [--line <order_line id>] --note "<who, what the dpay panel showed>" [--notify] [--apply]
//
// Records a refund the organizer made in the dpay merchant panel instead of through „Zwróć wpłatę”.
// dpay sends an IPN for a payment, never for a refund, so leszy.run never hears about such a refund:
// the order stays `paid`, the entry stays live and there is no `refunds` row. The registration-jobs
// step `external_refunds` finds them (operator alert `refund_external`, once a day per paid order,
// comparing dpay's /pbl/details refunded_amount with our accepted refunds); this script records one.
//
// Dry run by default: it prints the order, its lines and amounts, the refunds already stored and the
// registrations, dpay's refunded_amount for the paid transaction (read-only, when DPAY_* are in the
// environment), and exactly what --apply would write. Nothing changes.
// With --apply it calls record_external_refund, which records an accepted organizer refund (reason
// 'external') with the effects dpay's own answer has: order_lines.refunded and registrations.refunded
// move, and once the line is fully refunded the entry is cancelled and its slot released (a team line:
// the whole team; after closes_at a host_withdraw alert names the bibs instead of touching the
// participant). It never calls dpay. The runner gets no e-mail unless --notify: then registration-jobs'
// refund_emails step sends the club's usual refund e-mail within 15 minutes. One admin_actions row.
//
// RUNBOOK. Check the dpay panel FIRST: find the transaction this prints and read its refunds. Record
// only what the panel shows, never from the alert alone. --amount is in złoty ("60", "60,00", "12.5").
// --line is needed only when the order has more than one line with money left on it (an entry plus an
// extra or a donation): record each line's share as its own run. An identical re-run (same line, amount
// and note) is a no-op; a second refund of the same amount on the same line needs a different note.
// The amount may not exceed what is left on the line, nor, when dpay can be read, what dpay shows
// refunded beyond what is already recorded.
// The note goes into refunds.resolved_by and admin_actions (500 characters at most). It names the
// operator and what the panel showed, never the runner: e.g. "LG 2026-11-02: panel dpay, zwrot 1,00 zł".

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { dpayConfig, transactionDetails } from '../../supabase/functions/_shared/dpay.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AMOUNT_RE = /^(\d{1,6})(?:[.,](\d{1,2}))?$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/
const LIVE = ['pending', 'unknown']

// A value that is itself a flag counts as missing: `--note --apply` must not apply with the note "--apply".
function arg(name) {
  const i = process.argv.indexOf(name)
  const value = i === -1 ? undefined : process.argv[i + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function usage(message) {
  console.error(`${message}\n\nUsage: node --env-file=../.env scripts/record-external-refund.js ` +
    '(--order <id> | --email <buyer e-mail> --event <slug>) --amount <zł> [--line <id>] --note "<text>" [--notify] [--apply]')
  process.exit(2)
}

function refuse(message) {
  console.error(`\nRefused: ${message}`)
  process.exit(1)
}

const apply = process.argv.includes('--apply')
const notify = process.argv.includes('--notify')
const orderArg = arg('--order')
const emailArg = arg('--email')?.trim()
const eventArg = arg('--event')?.trim()
const amountArg = arg('--amount')?.trim()
const lineArg = arg('--line')
const note = arg('--note')?.trim()

if (orderArg !== undefined || process.argv.includes('--order')) {
  if (!orderArg || !UUID_RE.test(orderArg)) usage('--order must be an order id (uuid)')
} else {
  if (!emailArg || !emailArg.includes('@')) usage('give --order <id>, or --email <buyer e-mail> with --event <slug>')
  if (!eventArg || !SLUG_RE.test(eventArg)) usage('--event must be the event slug (with --email)')
}
const amountMatch = amountArg ? AMOUNT_RE.exec(amountArg) : null
const grosze = amountMatch ? Number(amountMatch[1]) * 100 + Number((amountMatch[2] ?? '').padEnd(2, '0')) : 0
if (!amountMatch || grosze <= 0) usage('--amount must be a positive amount in złoty, at most two decimals (e.g. 60 or 60,00)')
if (lineArg !== undefined && !UUID_RE.test(lineArg)) usage('--line must be an order line id (uuid)')
if (process.argv.includes('--line') && lineArg === undefined) usage('--line must be an order line id (uuid)')
if (!note) usage('--note is required: who recorded it, and what the dpay panel showed')
if (note.length > 500) usage('--note is longer than 500 characters')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } })

const pln = (g) => `${g < 0 ? '-' : ''}${Math.floor(Math.abs(g) / 100)},${String(Math.abs(g) % 100).padStart(2, '0')} zł`

async function select(table, columns, filter, { single = false } = {}) {
  let q = supabase.from(table).select(columns)
  for (const [k, v] of Object.entries(filter)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v)
  const { data, error } = single ? await q.maybeSingle() : await q
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

function show(title, row) {
  console.log(`\n${title}`)
  for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(22)} ${v ?? '—'}`)
}

// The same key record_external_refund derives: one (line, amount, note) is one refund.
const requestKey = (lineId) => `external:${crypto.createHash('md5').update(`${lineId}:${grosze}:${note}`).digest('hex')}`

async function findOrderId() {
  if (orderArg) return orderArg
  const settings = await select('registration_settings', 'event_id, slug', { slug: eventArg }, { single: true })
  if (!settings) refuse(`no event with the slug ${eventArg}`)
  const escaped = emailArg.replace(/[\\%_]/g, (c) => `\\${c}`)
  const { data, error } = await supabase.from('orders').select('id, status, total, paid_at')
    .eq('event_id', settings.event_id).ilike('buyer_email', escaped).order('created_at')
  if (error) throw new Error(`orders: ${error.message}`)
  const paid = (data ?? []).filter((o) => o.status === 'paid')
  if (!paid.length) refuse(`no paid order of that buyer in ${eventArg} (${(data ?? []).length} order(s) in another state)`)
  if (paid.length > 1) {
    console.error('\nThat buyer has more than one paid order in the event; run again with --order <id>:')
    for (const o of paid) console.error(`  ${o.id}  ${pln(o.total)}  paid ${o.paid_at}`)
    process.exit(1)
  }
  return paid[0].id
}

try {
  const orderId = await findOrderId()
  const order = await select('orders', 'id, status, total, event_id, paid_at, paid_transaction_id, buyer_name',
    { id: orderId }, { single: true })
  if (!order) refuse(`no order ${orderId}`)
  const [settings, lines, refunds, attempts] = await Promise.all([
    select('registration_settings', 'name, slug, event_date, closes_at', { event_id: order.event_id }, { single: true }),
    select('order_lines', 'id, kind, amount, refunded, registration_id', { order_id: order.id }),
    select('refunds', 'id, kind, reason, dpay_status, amount, order_line_id, payment_attempt_id, created_at, resolved_by, request_key',
      { order_id: order.id }),
    select('payment_attempts', 'id, dpay_transaction_id, grosze, status', { order_id: order.id }),
  ])
  const regIds = lines.map((l) => l.registration_id).filter(Boolean)
  const regs = regIds.length ? await select('registrations', 'id, status, refunded, team_id', { id: regIds }) : []
  const regById = new Map(regs.map((r) => [r.id, r]))
  const attempt = attempts.find((a) => a.dpay_transaction_id === order.paid_transaction_id) ?? null

  show('Order', {
    id: order.id, status: order.status, total: pln(order.total), buyer: order.buyer_name,
    event: `${settings?.name ?? order.event_id} (${settings?.slug ?? '—'}, ${settings?.event_date ?? '—'})`,
    paid_at: order.paid_at, transaction: order.paid_transaction_id,
  })
  console.log('\nLines')
  for (const l of lines) {
    const r = l.registration_id ? regById.get(l.registration_id) : null
    console.log(`  ${l.id}  ${l.kind.padEnd(8)} amount ${pln(l.amount)}  refunded/reserved ${pln(l.refunded)}  ` +
      `left ${pln(l.amount - l.refunded)}` + (r ? `  registration ${r.id} (${r.status}${r.team_id ? ', team' : ''})` : ''))
  }
  console.log('\nRefunds stored')
  if (!refunds.length) console.log('  none')
  for (const f of refunds) {
    console.log(`  ${f.id}  ${f.kind}/${f.reason}  ${f.dpay_status}  ${pln(f.amount)}  line ${f.order_line_id ?? '—'}  ` +
      `${f.created_at}${f.resolved_by ? `  note: ${f.resolved_by}` : ''}`)
  }

  const recorded = refunds.filter((f) => attempt && f.payment_attempt_id === attempt.id && f.dpay_status === 'accepted')
    .reduce((n, f) => n + f.amount, 0)
  const inFlight = refunds.filter((f) => attempt && f.payment_attempt_id === attempt.id && LIVE.includes(f.dpay_status))
    .reduce((n, f) => n + f.amount, 0)

  // dpay, read-only.
  let dpayRefunded = null
  let cfg = null
  try { cfg = dpayConfig(process.env) } catch { /* not configured */ }
  if (!cfg) {
    console.log('\ndpay not configured (no DPAY_* in the environment): refunded_amount not read; check the panel by hand.')
  } else if (!attempt) {
    console.log('\ndpay: the order has no paid transaction to read.')
  } else {
    try {
      const d = await transactionDetails(cfg, attempt.dpay_transaction_id)
      const avail = d.raw?.transaction?.available_refund_amount
      dpayRefunded = Number.isSafeInteger(d.refundedGrosze) ? d.refundedGrosze : null
      show(`dpay /pbl/details for ${attempt.dpay_transaction_id} (read-only)`, {
        status: d.status, value: d.grosze === null ? null : pln(d.grosze),
        refunded_amount: dpayRefunded === null ? 'unreadable' : pln(dpayRefunded),
        available_refund_amount: avail ?? null,
        recorded_in_leszy_run: pln(recorded), in_flight: pln(inFlight),
      })
    } catch (err) {
      console.log(`\ndpay: could not read the transaction (${err.message}); check the panel by hand.`)
    }
  }

  if (order.status !== 'paid' || !attempt) refuse(`the order is ${order.status}; only a paid order's refund can be recorded`)

  let line
  if (lineArg) {
    line = lines.find((l) => l.id === lineArg)
    if (!line) refuse(`line ${lineArg} is not on order ${order.id}`)
  } else {
    const open = lines.filter((l) => l.amount - l.refunded > 0)
    if (!open.length) refuse(`nothing left to refund on order ${order.id}: every line is refunded or reserved (left 0,00 zł)`)
    if (open.length > 1) {
      refuse(`the order has ${open.length} lines with money left; pick one with --line ` +
        `(${open.map((l) => `${l.id} ${l.kind} left ${pln(l.amount - l.refunded)}`).join('; ')})`)
    }
    line = open[0]
  }

  const replay = refunds.find((f) => f.request_key === requestKey(line.id))
  if (replay) {
    console.log(`\nAlready recorded as refund ${replay.id} (${replay.dpay_status}, ${pln(replay.amount)}) with this line, amount and note.` +
      ' --apply changes nothing.')
    if (!apply) {
      console.log('\nDRY RUN — nothing changed.')
      process.exit(0)
    }
  } else {
    const left = line.amount - line.refunded
    if (grosze > left) refuse(`${pln(grosze)} is more than is left on the line (${pln(left)})`)
    if (dpayRefunded !== null && recorded + inFlight + grosze > dpayRefunded) {
      refuse(`dpay shows ${pln(dpayRefunded)} refunded and leszy.run already holds ${pln(recorded + inFlight)}; ` +
        `recording ${pln(grosze)} more would exceed what dpay shows. Check the panel and the amount.`)
    }
    const reg = line.registration_id ? regById.get(line.registration_id) : null
    const acceptedOnLine = refunds.filter((f) => f.order_line_id === line.id && f.dpay_status === 'accepted')
      .reduce((n, f) => n + f.amount, 0)
    const covers = line.kind === 'entry' && acceptedOnLine + grosze >= line.amount && reg?.status === 'confirmed'
    const afterClose = settings?.closes_at && Date.now() >= Date.parse(settings.closes_at)
    console.log('\n--apply would write (record_external_refund, one transaction):')
    console.log(`  refunds         + 1 row: kind organizer, reason external, dpay_status accepted, ${pln(grosze)}, ` +
      `line ${line.id}, requested_at/responded_at now, resolved_by = the note`)
    console.log(`  order_lines     ${line.id}: refunded ${pln(line.refunded)} → ${pln(line.refunded + grosze)}`)
    if (line.kind === 'entry' && reg) console.log(`  registrations   ${reg.id}: refunded ${pln(reg.refunded)} → ${pln(reg.refunded + grosze)}`)
    if (covers) {
      console.log(`  cancel          registration ${reg.id}${reg.team_id ? ' and its whole team' : ''}, its slot released` +
        (afterClose ? '; after closes_at: a host_withdraw alert names the bibs to withdraw on the hosts' : ', its participant removed'))
    } else {
      console.log(`  entry           stays ${reg?.status ?? '—'} (the line is not fully refunded)`)
    }
    if (recorded + grosze >= attempt.grosze) console.log(`  payment_attempts ${attempt.id}: status → refunded`)
    console.log(`  e-mail          ${notify ? 'the club\'s refund e-mail, sent by registration-jobs within 15 minutes' : 'none (add --notify to send the club\'s refund e-mail)'}`)
    console.log('  admin_actions   + 1 row: record_external_refund')
    console.log(`  note            "${note}"`)
    if (!apply) {
      console.log('\nDRY RUN — nothing changed. Check the dpay panel, then add --apply.')
      process.exit(0)
    }
  }

  const { data, error } = await supabase.rpc('record_external_refund',
    { p_line_id: line.id, p_grosze: grosze, p_note: note, p_notify: notify })
  if (error) {
    const m = /^exceeds:(\d+)$/.exec(error.message)
    refuse(m ? `more than is left on the line (${pln(Number(m[1]))})` : `record_external_refund: ${error.message}`)
  }
  if (data.replay) {
    console.log(`\nAlready recorded: refund ${data.refundId}. Nothing changed.`)
    process.exit(0)
  }
  console.log(`\nRecorded: refund ${data.refundId} (${data.status}). Cancelled registrations: ${(data.cancelled ?? []).join(', ') || 'none'}.`)
  if (data.hostWithdraw) console.log('The entry was cancelled after closes_at: a host_withdraw alert names the bibs to withdraw on the hosts.')
  if (notify) console.log('The refund e-mail goes out with the next registration-jobs run (within 15 minutes).')
  process.exit(0)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
