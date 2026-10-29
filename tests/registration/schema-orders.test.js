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

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'

const NEW_TABLES = [
  'orders',
  'order_lines',
  'payment_attempts',
  'payment_events',
  'refunds',
  'operator_alerts',
  'event_payout_history',
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

async function expectCode(promise, code, what) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code} ${err.message}`)
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
      const write = await client.from(table).insert({ id: crypto.randomUUID() })
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
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { support_choice: null }))}`, '23514', 'entry 6000, choice null')
  const [free] = await db()`insert into public.orders ${sql(orderRow(event.id, { entry_total: 0, support_choice: null }))} returning status, support_choice`
  assert.deepEqual({ ...free }, { status: 'pending', support_choice: null })
  const [paid] = await db()`insert into public.orders ${sql(orderRow(event.id, { support_choice: true }))} returning support_fee, total`
  assert.deepEqual({ ...paid }, { support_fee: 120, total: 6120 + paymentFee(6120) })
})

test('P-12 order amounts: negative refused, total must add up, unknown status refused, paid needs paid_at and a transaction', async () => {
  const sql = db()
  const { event } = await seedEvent()
  for (const col of ['entry_total', 'extras_total', 'donation', 'support_fee', 'payment_fee', 'total']) {
    await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { [col]: -1 }))}`, '23514', `${col} -1`)
  }
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { total: 1 }))}`, '23514', 'total that does not add up')
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { status: 'refunded' }))}`, '23514', 'status refunded')
  await expectCode(sql`insert into public.orders ${sql(orderRow(event.id, { status: 'paid' }))}`, '23514', 'paid without paid_at')
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
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, refunded: 2001 })}`, '23514', 'refunded > amount')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, refunded: -1 })}`, '23514', 'refunded < 0')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, amount: -1 })}`, '23514', 'amount < 0')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, kind: 'tip' })}`, '23514', 'kind tip')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, qty: 0 })}`, '23514', 'qty 0')
  await expectCode(sql`insert into public.order_lines ${sql({ ...line, kind: 'entry' })}`, '23514', 'entry without registration')
  const [ok] = await db()`insert into public.order_lines ${sql({ ...line, refunded: 2000 })} returning qty, refunded`
  assert.deepEqual({ ...ok }, { qty: 1, refunded: 2000 })
  await expectCode(sql`update public.order_lines set refunded = amount + 1 where order_id = ${order.id}`, '23514', 'update refunded > amount')
})

test('P-12 payment_window_hours: default 168, 1 and 336 accepted, 0 and 337 refused; payout_mode club|custom', async () => {
  const sql = db()
  const { event, settings } = await seedEvent()
  assert.equal(settings.payment_window_hours, 168)
  assert.equal(settings.payout_mode, 'club')
  for (const h of [1, 24, 336]) {
    await db()`update public.registration_settings set payment_window_hours = ${h} where event_id = ${event.id}`
  }
  await expectCode(sql`update public.registration_settings set payment_window_hours = 337 where event_id = ${event.id}`, '23514', '337 h')
  await expectCode(sql`update public.registration_settings set payment_window_hours = 0 where event_id = ${event.id}`, '23514', '0 h')
  await expectCode(sql`update public.registration_settings set payment_window_hours = null where event_id = ${event.id}`, '23502', 'null h')
  await expectCode(sql`update public.registration_settings set payout_mode = 'bank' where event_id = ${event.id}`, '23514', 'payout_mode bank')
  await db()`update public.registration_settings set payout_mode = 'custom', payout_recipient = 'Fundacja X',
    payout_tax_id = '5260250995', payout_iban = 'PL61109010140000071219812874', payout_title = 'Zbiórka' where event_id = ${event.id}`
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
  await expectCode(sql`insert into public.payment_events ${sql({ order_id: order.id, kind: 'ipn', payload: sql.json({ id: txn, email: 'a@b.pl' }) })}`, '23514', 'payload with email')
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
