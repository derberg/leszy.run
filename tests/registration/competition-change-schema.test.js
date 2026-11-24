// Competition change, task 1: the surcharge order schema. Local stack only.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, admin } from './helpers/stack.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'

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

async function seed() {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `CC ${tag}`, slug: `cc-${tag}` })
  await insert('registration_settings', { event_id: event.id, club_id: ZT_CLUB })
  const cat = async (n) => {
    const c = await insert('categories', { event_id: event.id, name: n, slug: `${n}-${tag}` })
    await insert('competitions', { category_id: c.id, event_id: event.id, name: n, capacity: 10, sort_order: 0 })
    return c
  }
  const from = await cat('5km')
  const to = await cat('10km')
  const reg = await insert('registrations', {
    event_id: event.id, category_id: from.id, status: 'confirmed', consent_state: 'accepted',
    first_name: 'Ola', last_name: 'Test', birth_date: '1990-05-01', gender: 'K', email: `a-${tag}@x.pl`,
  })
  return { event, from, to, reg, tag }
}

function surchargeRow(s, regId, over = {}) {
  return {
    event_id: s.event.id, buyer_email: 'k@x.pl', kind: 'surcharge',
    entry_total: 2000, extras_total: 0, donation: 0, total: 2000,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    surcharge_registration_id: regId, surcharge_from_category_id: s.from.id,
    surcharge_to_category_id: s.to.id, surcharge_list_price: 5000, surcharge_price: 5000,
    ...over,
  }
}

async function code(promise) {
  try { await promise } catch (e) { return e.code }
  return 'ok'
}

test('surcharge order and line insert with every column; the buyer may be only an e-mail', async () => {
  const s = await seed()
  assert.ok(s.reg, 'registration seed failed')
  const o = await insert('orders', surchargeRow(s, s.reg.id))
  assert.equal(o.kind, 'surcharge')
  assert.equal(o.buyer_profile_id, null)
  const l = await insert('order_lines', { order_id: o.id, kind: 'surcharge', registration_id: s.reg.id, amount: 2000 })
  assert.equal(l.kind, 'surcharge')
})

test('a surcharge line needs a registration', async () => {
  const s = await seed()
  const o = await insert('orders', surchargeRow(s, s.reg.id))
  assert.equal(await code(db()`insert into public.order_lines (order_id, kind, amount) values (${o.id}, 'surcharge', 100)`), '23514')
})

test('a surcharge missing surcharge_price is refused (23514); a registration order carrying one too', async () => {
  const s = await seed()
  assert.equal(await code(db()`insert into public.orders (event_id, buyer_email, kind, entry_total, extras_total, donation, total, expires_at,
    surcharge_registration_id, surcharge_from_category_id, surcharge_to_category_id, surcharge_list_price)
    values (${s.event.id}, 'k@x.pl', 'surcharge', 1, 0, 0, 1, now() + interval '1 day', ${s.reg.id}, ${s.from.id}, ${s.to.id}, 5000)`), '23514')
  assert.equal(await code(db()`insert into public.orders (event_id, buyer_email, kind, entry_total, extras_total, donation, total, expires_at, surcharge_price)
    values (${s.event.id}, 'k@x.pl', 'registration', 1, 0, 0, 1, now() + interval '1 day', 5)`), '23514')
  assert.equal(await code(db()`insert into public.orders (event_id, buyer_email, kind, entry_total, extras_total, donation, total, expires_at)
    values (${s.event.id}, 'k@x.pl', 'bogus', 1, 0, 0, 1, now() + interval '1 day')`), '23514')
})

test('two pending surcharges for one registration are refused (23505); a cancelled one frees it', async () => {
  const s = await seed()
  const first = await insert('orders', surchargeRow(s, s.reg.id))
  assert.equal(await code(insert('orders', surchargeRow(s, s.reg.id)).catch((e) => { throw Object.assign(e, { code: /23505|orders_one_open_surcharge|duplicate/.test(e.message) ? '23505' : e.code }) })), '23505')
  await db()`update public.orders set status = 'cancelled' where id = ${first.id}`
  await insert('orders', surchargeRow(s, s.reg.id))
})

test('anon and authenticated cannot select the new order columns', async () => {
  const cols = ['kind', 'surcharge_registration_id', 'surcharge_from_category_id', 'surcharge_to_category_id', 'surcharge_list_price', 'surcharge_price']
  for (const role of ['anon', 'authenticated']) {
    for (const c of cols) {
      const [r] = await db()`select has_column_privilege(${role}, 'public.orders', ${c}, 'SELECT') as ok`
      assert.equal(r.ok, false, `${role} ${c}`)
    }
  }
})

test('refunds.reason accepts competition_change', async () => {
  const [r] = await db()`select count(*)::int n from pg_constraint where conrelid = 'public.refunds'::regclass and pg_get_constraintdef(oid) ilike '%reason%'`
  assert.equal(r.n, 0)
})
