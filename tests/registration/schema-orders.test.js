// Plan 3, task 3: the order schema (orders, order_lines, payment_attempts,
// payment_events, refunds, operator_alerts, event_payout_history, the payment
// settings on registration_settings) and the two SQL fee functions that mirror
// money.js. Runs against the LOCAL stack only (`supabase db reset` first).
// Scenario ids P-10…P-12 are in docs/registration/scenario-matrix.md.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { localEnv, admin, authenticatedClient } from './helpers/stack.js'
import { paymentFee, supportFee } from '../../supabase/functions/_shared/registration/money.js'
import { redactDpay } from '../../supabase/functions/_shared/registration/redactDpay.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'

const NEW_TABLES = [
  'orders',
  'order_lines',
  'payment_attempts',
  'payment_events',
  'refunds',
  'operator_alerts',
  'event_payout_history',
  'event_payout_details',
]

const NEW_FUNCTIONS = [
  ['registration_support_fee', 'integer, boolean', { p_entry: 6000, p_choice: true }],
  ['registration_payment_fee', 'integer', { p_subtotal: 10000 }],
]

function anon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

let sqlClient
function db() {
  if (!sqlClient) sqlClient = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  return sqlClient
}
after(async () => { if (sqlClient) await sqlClient.end() })

async function insert(table, row) {
  const { data, error } = await admin().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

/** A draft registration event with one competition. */
async function seedEvent() {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `Schema P ${tag}`, slug: `schema-p-${tag}` })
  const settings = await insert('registration_settings', { event_id: event.id, club_id: ZT_CLUB })
  const category = await insert('categories', { event_id: event.id, name: '10 km', slug: `10km-${tag}` })
  await insert('competitions', { category_id: category.id, event_id: event.id, name: '10 km', capacity: 10, sort_order: 0 })
  return { tag, event, settings, category }
}

/** A consistent pending order: entry 6000, support declined, payment fee 55. */
function orderRow(eventId, overrides = {}) {
  const entry = Number.isInteger(overrides.entry_total) && overrides.entry_total >= 0 ? overrides.entry_total : 6000
  const choice = 'support_choice' in overrides ? overrides.support_choice : false
  const support = entry > 0 && choice ? supportFee(entry, true) : 0
  const subtotal = entry + support
  const fee = paymentFee(subtotal)
  return {
    event_id: eventId,
    buyer_email: 'kupujacy@x.pl',
    entry_total: entry,
    extras_total: 0,
    donation: 0,
    support_choice: choice,
    support_fee: support,
    payment_fee: fee,
    total: subtotal + fee,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    ...overrides,
  }
}

/** Rejects with `code`; when `constraint` is given, it must be the constraint that fired. */
async function expectCode(promise, code, what, constraint) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code} ${err.message}`)
    if (constraint) assert.equal(err.constraint_name, constraint, `${what}: fired ${err.constraint_name}`)
    return true
  }, what)
}

// ---------------------------------------------------------------- P-10

test('P-10 anon and authenticated cannot select or insert into any new order table', async () => {
  for (const [who, client] of [['anon', anon()], ['authenticated', authenticatedClient()]]) {
    for (const table of NEW_TABLES) {
      const read = await client.from(table).select('*').limit(1)
      assert.ok(read.error, `${who} read ${table} (data: ${JSON.stringify(read.data)})`)
      assert.match(read.error.message, /permission denied/, `${who} ${table}: ${read.error.message}`)
      const write = await client.from(table).insert({})
      assert.ok(write.error, `${who} inserted into ${table}`)
      assert.match(write.error.message, /permission denied/, `${who} insert ${table}: ${write.error.message}`)
    }
  }
})

test('P-10 anon and authenticated hold no privilege on the new tables, RLS is on', async () => {
  for (const table of NEW_TABLES) {
    const [row] = await db()`
      select c.relrowsecurity as rls,
             has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon,
             has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth
        from pg_class c where c.oid = to_regclass(${'public.' + table})`
    assert.ok(row, `${table} does not exist`)
    assert.deepEqual({ ...row }, { rls: true, anon: false, auth: false }, table)
  }
})

test('P-10 anon and authenticated cannot execute the fee functions; service_role can', async () => {
  for (const [name, args, params] of NEW_FUNCTIONS) {
    const [row] = await db()`
      select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             p.provolatile = 'i' as immutable,
             coalesce(array_to_string(p.proconfig, ','), '') as config
        from pg_proc p where p.oid = to_regprocedure(${`public.${name}(${args})`})`
    assert.ok(row, `${name}(${args}) does not exist`)
    assert.deepEqual({ ...row }, { anon: false, auth: false, service: true, immutable: true, config: 'search_path=""' }, name)
    for (const [who, client] of [['anon', anon()], ['authenticated', authenticatedClient()]]) {
      const { error } = await client.rpc(name, params)
      assert.ok(error, `${who} executed ${name}`)
      assert.match(error.message, /permission denied/, `${who} ${name}: ${error.message}`)
    }
    const { error } = await admin().rpc(name, params)
    assert.equal(error, null, error?.message)
  }
})

// ---------------------------------------------------------------- P-11

test('P-11 registration_payment_fee equals money.js paymentFee for every subtotal 0…100 000', async () => {
  const rows = await db()`select s, public.registration_payment_fee(s) as fee from generate_series(0, 100000) s order by s`
  assert.equal(rows.length, 100001)
  const diffs = rows.filter((r) => r.fee !== paymentFee(r.s))
  assert.deepEqual(diffs.slice(0, 5).map((r) => ({ ...r })), [], `${diffs.length} differences`)
})

test('P-11 registration_support_fee equals money.js supportFee for every entry 0…100 000, both choices', async () => {
  const rows = await db()`
    select s, public.registration_support_fee(s, true) as yes, public.registration_support_fee(s, false) as no
      from generate_series(0, 100000) s order by s`
  assert.equal(rows.length, 100001)
  const diffs = rows.filter((r) => r.yes !== supportFee(r.s, true) || r.no !== supportFee(r.s, false))
  assert.deepEqual(diffs.slice(0, 5).map((r) => ({ ...r })), [], `${diffs.length} differences`)
})

test('P-11 the SQL fee functions refuse what money.js refuses: null choice, negative, above the dpay cap', async () => {
  await assert.rejects(db()`select public.registration_support_fee(6000, null)`, /support_choice_required/)
  await assert.rejects(db()`select public.registration_support_fee(-1, true)`, /invalid_amount/)
  await assert.rejects(db()`select public.registration_payment_fee(-1)`, /invalid_amount/)
  await assert.rejects(db()`select public.registration_payment_fee(100000000)`, /invalid_amount/)
  await assert.rejects(db()`select public.registration_payment_fee(null)`, /invalid_amount/)
  const [top] = await db()`select public.registration_payment_fee(99999999) as fee`
  assert.equal(top.fee, paymentFee(99_999_999))
})

// ---------------------------------------------------------------- P-12

test('P-12 an order with entry fees and no support choice is refused; a free order needs none', async () => {
  const sql = db()
  const { event } = await seedEvent()
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { support_choice: null }))}`, '23514', 'entry 6000, choice null', 'orders_support_choice_check')
  const [free] = await db()`insert into public.orders ${sql(orderRow(event.id, { entry_total: 0, support_choice: null }))} returning status, support_choice`
  assert.deepEqual({ ...free }, { status: 'pending', support_choice: null })
  const [paid] = await db()`insert into public.orders ${sql(orderRow(event.id, { support_choice: true }))} returning support_fee, total`
  assert.deepEqual({ ...paid }, { support_fee: 120, total: 6120 + paymentFee(6120) })
})

test('P-12 order amounts: negative refused, total must add up, unknown status refused, paid needs paid_at and a transaction', async () => {
  const sql = db()
  const { event } = await seedEvent()
  // Each negative row still adds up (total adjusted by the same -1 - base), so only the
  // column's own >= 0 check can refuse it.
  const base = orderRow(event.id)
  for (const col of ['entry_total', 'extras_total', 'donation', 'support_fee', 'payment_fee']) {
    const row = { ...base, [col]: -1, total: base.total - base[col] - 1 }
    await expectCode(sql`insert into public.orders ${sql(row)}`, '23514', `${col} -1`, `orders_${col}_check`)
  }
  // A negative total cannot add up from non-negative parts, so it trips either check.
  await assert.rejects(sql`insert into public.orders ${sql({ ...base, total: -1 })}`, (err) =>
    err.code === '23514' && ['orders_total_check', 'orders_amounts_add_up_check'].includes(err.constraint_name))
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { total: 1 }))}`, '23514', 'total that does not add up', 'orders_amounts_add_up_check')
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { status: 'refunded' }))}`, '23514', 'status refunded', 'orders_status_check')
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { status: 'paid' }))}`, '23514', 'paid without paid_at', 'orders_paid_check')
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { status: 'paid', paid_at: new Date().toISOString() }))}`,
    '23514', 'paid, total > 0, no transaction', 'orders_paid_check')
  // C1: a free order (total 0) is paid with no dpay transaction at all.
  const free = orderRow(event.id, { entry_total: 0, support_choice: null, status: 'paid', paid_at: new Date().toISOString() })
  assert.equal(free.total, 0)
  const [paidFree] = await sql`insert into public.orders ${sql(free)} returning status, paid_transaction_id`
  assert.deepEqual({ ...paidFree }, { status: 'paid', paid_transaction_id: null })
  await expectCode(sql`insert into public.orders ${sql({ ...free, paid_at: null })}`, '23514', 'free paid order without paid_at', 'orders_paid_check')
  const { expires_at, ...noExpiry } = orderRow(event.id)
  await expectCode(sql`insert into public.orders ${sql(noExpiry)}`, '23502', 'no expires_at')
  const txn = `T${crypto.randomUUID().slice(0, 12)}`
  await db()`insert into public.orders ${sql(orderRow(event.id, { status: 'paid', paid_at: new Date().toISOString(), paid_transaction_id: txn }))}`
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { status: 'paid', paid_at: new Date().toISOString(), paid_transaction_id: txn }))}`, '23505', 'paid_transaction_id twice')
})

test('P-12 order_lines: refunded above amount, negative or an entry without a registration refused', async () => {
  const sql = db()
  const { event } = await seedEvent()
  const [order] = await db()`insert into public.orders ${sql(orderRow(event.id))} returning id`
  const line = { order_id: order.id, kind: 'donation', amount: 2000 }
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, refunded: 2001 })}`, '23514', 'refunded > amount', 'order_lines_refunded_check')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, refunded: -1 })}`, '23514', 'refunded < 0', 'order_lines_refunded_check')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, amount: -1 })}`, '23514', 'amount < 0', 'order_lines_amount_check')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, kind: 'tip' })}`, '23514', 'kind tip')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, qty: 0 })}`, '23514', 'qty 0')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, kind: 'entry' })}`, '23514', 'entry without registration')
  const [ok] = await db()`insert into public.order_lines ${sql({ ...line, refunded: 2000 })} returning qty, refunded, tier_label, tier_ends_on`
  assert.deepEqual({ ...ok }, { qty: 1, refunded: 2000, tier_label: null, tier_ends_on: null })
  await expectCode(sql`update public.order_lines set refunded = amount + 1 where order_id = ${order.id}`, '23514', 'update refunded > amount')
})

test('P-12 payment_window_hours: default 168, 1 and 336 accepted, 0, 337 and null refused', async () => {
  const sql = db()
  const { event, settings } = await seedEvent()
  assert.equal(settings.payment_window_hours, 168)
  for (const h of [1, 24, 336]) {
    await sql`update public.registration_settings set payment_window_hours = ${h} where event_id = ${event.id}`
  }
  await expectCode(sql`update public.registration_settings set payment_window_hours = 337 where event_id = ${event.id}`, '23514', '337 h', 'registration_settings_payment_window_hours_check')
  await expectCode(sql`update public.registration_settings set payment_window_hours = 0 where event_id = ${event.id}`, '23514', '0 h', 'registration_settings_payment_window_hours_check')
  await expectCode(sql`update public.registration_settings set payment_window_hours = null where event_id = ${event.id}`, '23502', 'null h')
})

// Ruling P3-R1: the per-event payout (IBAN, NIP, recipient) never sits on registration_settings,
// which get-registration-event returns whole to every club member.
test('P-12 per-event payout lives in event_payout_details, not on registration_settings', async () => {
  const sql = db()
  const cols = await sql`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'registration_settings' and column_name like 'payout%'`
  assert.deepEqual(cols.map((r) => r.column_name), [])

  const { event } = await seedEvent()
  const [row] = await sql`insert into public.event_payout_details ${sql({ event_id: event.id })} returning payout_mode, payout_iban, updated_at`
  assert.equal(row.payout_mode, 'club')
  assert.equal(row.payout_iban, null)
  assert.ok(row.updated_at)
  await expectCode(sql`insert into public.event_payout_details ${sql({ event_id: event.id })}`, '23505', 'second payout row for one event')
  await expectCode(sql`update public.event_payout_details set payout_mode = 'bank' where event_id = ${event.id}`, '23514', 'payout_mode bank', 'event_payout_details_payout_mode_check')
  await expectCode(sql`update public.event_payout_details set payout_mode = null where event_id = ${event.id}`, '23502', 'payout_mode null')
  await sql`update public.event_payout_details set payout_mode = 'custom', payout_recipient = 'Fundacja X',
    payout_tax_id = '5260250995', payout_iban = 'PL61109010140000071219812874', payout_title = 'Zbiórka' where event_id = ${event.id}`
  await expectCode(sql`insert into public.event_payout_details ${sql({ event_id: crypto.randomUUID() })}`, '23503', 'payout for no event')
})

test('P-12 payment attempts, events and refunds: their checks, and one automatic refund per attempt', async () => {
  const sql = db()
  const { event } = await seedEvent()
  const [order] = await db()`insert into public.orders ${sql(orderRow(event.id))} returning id, total`
  const txn = `T${crypto.randomUUID().slice(0, 12)}`
  const [attempt] = await db()`insert into public.payment_attempts ${sql({ order_id: order.id, dpay_transaction_id: txn, grosze: order.total })} returning id, status`
  assert.equal(attempt.status, 'created')
  await expectCode(sql`insert into public.payment_attempts ${sql({ order_id: order.id, dpay_transaction_id: txn, grosze: order.total })}`, '23505', 'same dpay transaction twice')
  await expectCode(sql`insert into public.payment_attempts ${sql({ order_id: order.id, dpay_transaction_id: `${txn}b`, grosze: order.total, status: 'expired' })}`, '23514', 'attempt status expired')

  // Ruling 5: the payer e-mail is never stored in plaintext.
  const ev = (payload, extra = {}) => sql`insert into public.payment_events ${sql({ order_id: order.id, kind: 'ipn', payload: sql.json(payload), ...extra })}`
  await expectCode(ev({ id: txn, email: 'a@b.pl' }), '23514', 'payload with email', 'payment_events_no_plain_email_check')
  // Ruling P3-R2: any depth, any case, and the payload must be an object.
  await expectCode(ev({ id: txn, body: { payer: { Email: 'a@b.pl' } } }), '23514', 'nested Email key', 'payment_events_no_plain_email_check')
  await expectCode(ev({ list: [{ EMAIL: 'a@b.pl' }] }), '23514', 'EMAIL inside an array', 'payment_events_no_plain_email_check')
  await expectCode(ev('{"id":"x","email":"a@b.pl"}'), '23514', 'a raw string payload', 'payment_events_payload_object_check')
  await expectCode(ev([{ id: txn }]), '23514', 'an array payload', 'payment_events_payload_object_check')
  await expectCode(ev({ id: txn }, { response: '{"email":"a@b.pl"}' }), '23514', 'response with an email', 'payment_events_response_no_email_check')
  await expectCode(ev({ id: txn }, { response: 'paid by a@b.pl' }), '23514', 'response with an address', 'payment_events_response_no_email_check')
  // A key that merely contains the word is not refused: email_sha256 lives in its own column anyway.
  await ev({ id: txn, emailVerified: true }, { response: '{"status":true,"msg":"https://secure.dpay.pl/x"}' })
  // What redactDpay leaves is always accepted.
  await ev(redactDpay({ id: txn, body: { payer: { Email: 'a@b.pl', note: 'from a@b.pl' } }, list: [{ email: 'x@y.pl' }] }))
  await expectCode(sql`insert into public.payment_events ${sql({ order_id: order.id, kind: 'webhook', payload: sql.json({}) })}`, '23514', 'kind webhook')
  await expectCode(sql`insert into public.payment_events ${sql({ order_id: order.id, kind: 'ipn', payload: sql.json({}), email_sha256: 'a@b.pl' })}`, '23514', 'email_sha256 not a digest')
  const sha = crypto.createHash('sha256').update('a@b.pl').digest('hex')
  await db()`insert into public.payment_events ${sql({ order_id: order.id, payment_attempt_id: attempt.id, kind: 'ipn', payload: sql.json({ id: txn }), email_sha256: sha, checksum_ok: true, response: 'OK' })}`
  await db()`insert into public.payment_events ${sql({ kind: 'ipn', payload: sql.json({ id: 'forged' }), checksum_ok: false, response: 'OK' })}`

  const refund = { order_id: order.id, payment_attempt_id: attempt.id, amount: order.total, kind: 'automatic', reason: 'double_payment' }
  const msg = () => `R${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  await expectCode(sql`insert into public.refunds ${sql({ ...refund, amount: 0, message_id: msg() })}`, '23514', 'refund 0')
  await expectCode(sql`insert into public.refunds ${sql({ ...refund, kind: 'manual', message_id: msg() })}`, '23514', 'refund kind manual')
  await expectCode(sql`insert into public.refunds ${sql({ ...refund, message_id: 'x'.repeat(25) })}`, '23514', 'message id over 24')
  await expectCode(sql`insert into public.refunds ${sql({ ...refund, dpay_status: 'done', message_id: msg() })}`, '23514', 'dpay_status done')
  const first = msg()
  const [r1] = await db()`insert into public.refunds ${sql({ ...refund, message_id: first })} returning dpay_status, attempts`
  assert.deepEqual({ ...r1 }, { dpay_status: 'pending', attempts: 0 })
  await expectCode(sql`insert into public.refunds ${sql({ ...refund, message_id: msg() })}`, '23505', 'second automatic refund of one attempt')
  await expectCode(sql`insert into public.refunds ${sql({ ...refund, kind: 'organizer', message_id: first })}`, '23505', 'message id reused')
  // Organizer refunds of the same attempt are not limited by the partial index.
  await db()`insert into public.refunds ${sql({ ...refund, kind: 'organizer', amount: 100, message_id: msg() })}`
  await db()`insert into public.refunds ${sql({ ...refund, kind: 'organizer', amount: 100, message_id: msg() })}`
})

test('P-12 registrations.order_id references orders (restrict); operator_alerts and payout history store', async () => {
  const sql = db()
  const { event, category } = await seedEvent()
  const person = {
    event_id: event.id, category_id: category.id, status: 'pending_payment', consent_state: 'accepted',
    first_name: 'Ola', last_name: 'Test', birth_date: '1990-05-01', gender: 'K', email: `ola-${crypto.randomUUID().slice(0, 6)}@x.pl`,
  }
  await expectCode(sql`insert into public.registrations ${sql({ ...person, order_id: crypto.randomUUID() })}`, '23503', 'order_id of no order')
  const [order] = await db()`insert into public.orders ${sql(orderRow(event.id))} returning id`
  await db()`insert into public.registrations ${sql({ ...person, order_id: order.id })}`
  await expectCode(sql`delete from public.orders where id = ${order.id}`, '23503', 'delete an order with registrations')

  const [alert] = await db()`insert into public.operator_alerts ${sql({ kind: 'amount_mismatch', order_id: order.id, payload: sql.json({ paid: 1 }) })} returning created_at, emailed_at`
  assert.ok(alert.created_at)
  assert.equal(alert.emailed_at, null)
  const [hist] = await db()`insert into public.event_payout_history ${sql({ event_id: event.id, old: sql.json({ payout_mode: 'club' }), new: sql.json({ payout_mode: 'custom' }) })} returning changed_at`
  assert.ok(hist.changed_at)
})

test('P-12 every foreign key on the new tables is indexed, and orders (status, expires_at) is', async () => {
  const sql = db()
  const unindexed = await db()`
    select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and array_length(c.conkey, 1) = 1
       and c.conrelid = any (${NEW_TABLES.map((t) => `public.${t}`)}::regclass[])
       and not exists (
         select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`
  assert.deepEqual(unindexed.map((r) => ({ ...r })), [])
  const [idx] = await db()`
    select count(*)::int as n from pg_indexes
     where schemaname = 'public' and tablename = 'orders' and indexdef like '%(status, expires_at)%'`
  assert.equal(idx.n, 1)
})

test('P-12 the job scans have partial indexes: expired-notice, refund retry, unsent alerts', async () => {
  const rows = await db()`
    select tablename, indexdef from pg_indexes
     where schemaname = 'public' and tablename in ('orders', 'refunds', 'operator_alerts') and indexdef like '% WHERE %'`
  const has = (table, ...parts) => rows.some((r) => r.tablename === table && parts.every((p) => r.indexdef.includes(p)))
  assert.ok(has('orders', 'expired_notified_at IS NULL', "'expired'"), 'orders expired-notice index')
  assert.ok(has('refunds', '(next_retry_at)', 'next_retry_at IS NOT NULL'), 'refunds next_retry_at index')
  assert.ok(has('operator_alerts', 'emailed_at IS NULL'), 'operator_alerts unsent index')
})

// Ruling P3-R3: an order line keeps the tier its price came from, since price_tiers rows are
// deleted on repricing (orders.tier_id is ON DELETE SET NULL).
test('P-12 order lines snapshot the tier label and end date; the line survives the tier', async () => {
  const sql = db()
  const { event } = await seedEvent()
  const [tier] = await sql`insert into public.price_tiers ${sql({ event_id: event.id, ends_on: '2026-11-30', sort_order: 0 })} returning id`
  const [order] = await sql`insert into public.orders ${sql(orderRow(event.id, { tier_id: tier.id }))} returning id`
  const [line] = await sql`insert into public.order_lines ${sql({ order_id: order.id, kind: 'donation', amount: 6000, tier_label: 'Do 30 listopada', tier_ends_on: '2026-11-30' })}
    returning id, tier_label, to_char(tier_ends_on, 'YYYY-MM-DD') as tier_ends_on`
  assert.deepEqual({ tier_label: line.tier_label, tier_ends_on: line.tier_ends_on }, { tier_label: 'Do 30 listopada', tier_ends_on: '2026-11-30' })
  await sql`delete from public.price_tiers where id = ${tier.id}`
  const [after] = await sql`select o.tier_id, l.tier_label, to_char(l.tier_ends_on, 'YYYY-MM-DD') as tier_ends_on
    from public.orders o join public.order_lines l on l.order_id = o.id where l.id = ${line.id}`
  assert.deepEqual({ ...after }, { tier_id: null, tier_label: 'Do 30 listopada', tier_ends_on: '2026-11-30' })
})
