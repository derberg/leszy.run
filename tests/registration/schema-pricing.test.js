// Plan 7, task 2: the schema of vouchers, partners, extras and transfers, and the SQL mirrors of
// the pricing rules. Scenarios V-10…V-14 in docs/registration/scenario-matrix.md. LOCAL stack only.
// Rows are inserted directly (service role or the postgres role), so no edge function is needed.
import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { localEnv, admin, authenticatedClient } from './helpers/stack.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { currentTier, discountedPrice, MAX_LIST_PRICE } from '../../supabase/functions/_shared/registration/pricing.js'
import { MAX_VOUCHER_USES } from '../../supabase/functions/_shared/registration/vouchers.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'

const NEW_TABLES = [
  'registration_partners',
  'vouchers',
  'voucher_competitions',
  'extras',
  'extra_variants',
  'extra_competitions',
  'transfers',
]

const NEW_FUNCTIONS = [
  'public.registration_discounted_price(integer, integer)',
  'public.registration_current_tier(uuid, timestamp with time zone)',
  'public.registration_tier_price(uuid, uuid)',
  'public.registration_current_price(uuid)',
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

const vouchersSeen = new Set()
afterEach(async () => {
  for (const id of vouchersSeen) await assertVoucherInvariant(id)
  vouchersSeen.clear()
})

async function insert(table, row) {
  const { data, error } = await admin().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

/** A draft registration event with one competition, and no price tiers. */
async function seedEvent() {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `Schema V ${tag}`, slug: `schema-v-${tag}` })
  const settings = await insert('registration_settings', { event_id: event.id, club_id: ZT_CLUB })
  const category = await insert('categories', { event_id: event.id, name: '10 km', slug: `10km-${tag}` })
  await insert('competitions', { category_id: category.id, event_id: event.id, name: '10 km', capacity: 10, sort_order: 0 })
  return { tag, event, settings, category, eventId: event.id, categoryId: category.id }
}

const registrationRow = (s, over = {}) => ({
  event_id: s.eventId, category_id: s.categoryId, status: 'confirmed', consent_state: 'accepted',
  first_name: 'Anna', last_name: 'Las', email: `v-${crypto.randomBytes(4).toString('hex')}@test.local`, ...over,
})

const voucherRow = (s, over = {}) => ({
  event_id: s.eventId, code: `LESZY-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, percent: 15, max_uses: 1, ...over,
})

async function voucher(s, over) {
  const v = await insert('vouchers', voucherRow(s, over))
  vouchersSeen.add(v.id)
  return v
}

const sha = () => crypto.randomBytes(32).toString('hex')

/** Rejects with `code`; when `constraint` is given, it must be the constraint that fired. */
async function expectCode(promise, code, what, constraint) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code} ${err.message}`)
    if (constraint) assert.equal(err.constraint_name, constraint, `${what}: fired ${err.constraint_name}`)
    return true
  }, what)
}

// ---------------------------------------------------------------- V-10

test('V-10 anon and authenticated cannot select or insert into any new table', async () => {
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

test('V-10 anon and authenticated hold no privilege on the new tables, RLS is on', async () => {
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

test('V-10 nobody but the owner may execute the pricing functions; they run as their caller with an empty search_path', async () => {
  for (const fn of NEW_FUNCTIONS) {
    const [exists] = await db()`select to_regprocedure(${fn}) as oid`
    assert.ok(exists.oid, `${fn} does not exist`)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [{ allowed }] = await db()`select has_function_privilege(${role}, ${fn}, 'EXECUTE') as allowed`
      assert.equal(allowed, false, `${role} may execute ${fn}`)
    }
    const [p] = await db()`select prosecdef, proconfig from pg_proc where oid = to_regprocedure(${fn})`
    assert.equal(p.prosecdef, false, `${fn} is SECURITY DEFINER`)
    assert.deepEqual(p.proconfig, ['search_path=""'], fn)
  }
  // The single-argument tier helper is gone: two overloads would make every one-argument call ambiguous.
  const [old] = await db()`select to_regprocedure('public.registration_current_tier(uuid)') as oid`
  assert.equal(old.oid, null)
  for (const [who, client] of [['anon', anon()], ['authenticated', authenticatedClient()]]) {
    const r = await client.rpc('registration_discounted_price', { p_list: 6000, p_percent: 15 })
    assert.ok(r.error, `${who} executed registration_discounted_price`)
  }
})

// ---------------------------------------------------------------- V-11

test('V-11 SQL = JS: registration_discounted_price over every list 0…100 000 at 8 percents', async () => {
  const percents = [1, 5, 10, 15, 33, 50, 99, 100]
  const rows = await db()`
    select p, array_agg(public.registration_discounted_price(l, p) order by l) as prices
      from generate_series(0, 100000) l, unnest(${percents}::int[]) p
     group by p`
  assert.equal(rows.length, percents.length)
  let differences = 0
  let first = null
  for (const { p, prices } of rows) {
    assert.equal(prices.length, 100001)
    for (let l = 0; l <= 100000; l++) {
      if (prices[l] !== discountedPrice(l, p)) {
        differences++
        first ??= { l, p, sql: prices[l], js: discountedPrice(l, p) }
      }
    }
  }
  assert.equal(differences, 0, `first difference: ${JSON.stringify(first)}`)
})

test('V-11 SQL = JS: every percent 1…100 for 1 000 seeded lists up to the cap', async () => {
  // Mulberry32: a fixed seed, so a failure names the same lists every run.
  let seed = 0x5eed7
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const lists = [0, 1, 99, 4999, 6000, 2_147_483, MAX_LIST_PRICE - 1, MAX_LIST_PRICE]
  while (lists.length < 1000) lists.push(Math.floor(rnd() * (MAX_LIST_PRICE + 1)))
  const rows = await db()`
    select l, array_agg(public.registration_discounted_price(l, p) order by p) as prices
      from unnest(${lists}::int[]) l, generate_series(1, 100) p
     group by l`
  const byList = new Map(rows.map((r) => [r.l, r.prices]))
  let differences = 0
  let first = null
  for (const l of lists) {
    const prices = byList.get(l)
    assert.equal(prices?.length, 100, `list ${l}`)
    for (let p = 1; p <= 100; p++) {
      if (prices[p - 1] !== discountedPrice(l, p)) {
        differences++
        first ??= { l, p, sql: prices[p - 1], js: discountedPrice(l, p) }
      }
    }
  }
  assert.equal(differences, 0, `first difference: ${JSON.stringify(first)}`)
})

test('V-11 registration_discounted_price: null percent is the list price; bad input raises like the JS', async () => {
  const [row] = await db()`
    select public.registration_discounted_price(4999, null) as none,
           public.registration_discounted_price(4999, 15) as named,
           public.registration_discounted_price(${MAX_LIST_PRICE}, 99) as cap`
  assert.deepEqual({ ...row }, { none: 4999, named: 4250, cap: discountedPrice(MAX_LIST_PRICE, 99) })
  for (const [list, percent, what] of [
    [6000, 0, 'percent 0'], [6000, 101, 'percent 101'], [-1, 15, 'negative list'],
    [MAX_LIST_PRICE + 1, 15, 'list above the cap'], [2147483647, 100, 'list at int4 max'], [null, 15, 'null list'],
  ]) {
    assert.throws(() => discountedPrice(list, percent), undefined, `JS ${what}`)
    await expectCode(db()`select public.registration_discounted_price(${list}::int, ${percent}::int)`, '22023', `SQL ${what}`)
  }
})

// ---------------------------------------------------------------- V-12

// The V-03 instants: last ms of the first tier and first ms of the next, DST days included.
const TIER_CASES = [
  {
    tiers: [{ endsOn: '2026-11-15', sortOrder: 0 }, { endsOn: '2026-11-25', sortOrder: 1 }, { endsOn: null, sortOrder: 2 }],
    instants: ['2026-11-10T12:00:00.000Z', '2026-11-15T22:59:59.999Z', '2026-11-15T23:00:00.000Z',
      '2026-11-25T22:59:59.999Z', '2026-11-25T23:00:00.000Z', '2027-06-01T00:00:00.000Z'],
  },
  { tiers: [{ endsOn: '2026-10-24', sortOrder: 0 }, { endsOn: null, sortOrder: 1 }], instants: ['2026-10-24T21:59:59.999Z', '2026-10-24T22:00:00.000Z'] },
  { tiers: [{ endsOn: '2026-10-25', sortOrder: 0 }, { endsOn: null, sortOrder: 1 }], instants: ['2026-10-25T22:59:59.999Z', '2026-10-25T23:00:00.000Z'] },
  { tiers: [{ endsOn: '2026-03-28', sortOrder: 0 }, { endsOn: null, sortOrder: 1 }], instants: ['2026-03-28T22:59:59.999Z', '2026-03-28T23:00:00.000Z'] },
  { tiers: [{ endsOn: '2026-03-29', sortOrder: 0 }, { endsOn: null, sortOrder: 1 }], instants: ['2026-03-29T21:59:59.999Z', '2026-03-29T22:00:00.000Z'] },
  // No open tier: after the last day there is no current tier on either side.
  { tiers: [{ endsOn: '2026-11-15', sortOrder: 0 }], instants: ['2026-11-15T22:59:59.999Z', '2026-11-15T23:00:00.000Z'] },
  // Ties on ends_on are broken by sort_order, then id, the same way on both sides.
  { tiers: [{ endsOn: '2026-11-15', sortOrder: 1 }, { endsOn: '2026-11-15', sortOrder: 0 }, { endsOn: null, sortOrder: 0 }, { endsOn: null, sortOrder: 0 }],
    instants: ['2026-11-01T00:00:00.000Z', '2026-11-16T00:00:00.000Z'] },
]

test('V-12 registration_current_tier at the V-03 instants equals currentTier', async () => {
  for (const { tiers, instants } of TIER_CASES) {
    const s = await seedEvent()
    const withIds = tiers.map((t) => ({ ...t, id: crypto.randomUUID() }))
    for (const t of withIds) {
      await insert('price_tiers', { id: t.id, event_id: s.eventId, ends_on: t.endsOn, sort_order: t.sortOrder })
    }
    for (const instant of instants) {
      const [row] = await db()`select o_id from public.registration_current_tier(${s.eventId}::uuid, ${instant}::timestamptz)`
      const js = currentTier(withIds, new Date(instant))
      assert.equal(row?.o_id ?? null, js?.id ?? null, `${JSON.stringify(tiers.map((t) => t.endsOn))} at ${instant}`)
    }
  }
})

test('V-12 registration_tier_price and registration_current_price read the current tier', async () => {
  const s = await seedEvent()
  const t1 = await insert('price_tiers', { event_id: s.eventId, ends_on: '2099-01-01', sort_order: 0 })
  const t2 = await insert('price_tiers', { event_id: s.eventId, ends_on: null, sort_order: 1 })
  await insert('competition_prices', { category_id: s.categoryId, tier_id: t1.id, amount: 6000 })
  await insert('competition_prices', { category_id: s.categoryId, tier_id: t2.id, amount: 8000 })
  const [row] = await db()`
    select public.registration_tier_price(${s.categoryId}::uuid, ${t1.id}::uuid) as p1,
           public.registration_tier_price(${s.categoryId}::uuid, ${t2.id}::uuid) as p2,
           public.registration_tier_price(${s.categoryId}::uuid, ${crypto.randomUUID()}::uuid) as missing,
           public.registration_current_price(${s.categoryId}::uuid) as now,
           (select o_id from public.registration_current_tier(${s.eventId}::uuid)) as tier,
           (select o_label from public.registration_current_tier(${s.eventId}::uuid)) as label`
  assert.deepEqual({ ...row }, { p1: 6000, p2: 8000, missing: null, now: 6000, tier: t1.id, label: 'do 01.01.2099' })
})

// ---------------------------------------------------------------- V-13

test('V-13 extra stock: sold above stock, negative, or stock above 100 000 is refused', async () => {
  const s = await seedEvent()
  const extra = await insert('extras', { event_id: s.eventId, name: 'Koszulka', price: 5000, order_until: '2099-01-01' })
  const v = await insert('extra_variants', { extra_id: extra.id, label: 'M', stock: 2 })
  assert.equal(v.sold, 0)
  await expectCode(db()`update public.extra_variants set sold = 3 where id = ${v.id}`, '23514', 'sold > stock')
  await expectCode(db()`update public.extra_variants set sold = -1 where id = ${v.id}`, '23514', 'sold < 0')
  await expectCode(db()`update public.extra_variants set stock = 100001 where id = ${v.id}`, '23514', 'stock > 100 000')
  await db()`update public.extra_variants set stock = 100000, sold = 100000 where id = ${v.id}`
  await expectCode(db()`insert into public.extras ${db()({ event_id: s.eventId, name: 'Medal', price: -1, order_until: '2099-01-01' })}`, '23514', 'negative price')
  await expectCode(db()`insert into public.extras ${db()({ event_id: s.eventId, name: 'Medal', price: MAX_LIST_PRICE + 1, order_until: '2099-01-01' })}`, '23514', 'price above the cap')
  await expectCode(db()`insert into public.extras (event_id, name, price) values (${s.eventId}, 'Medal', 100)`, '23502', 'no order_until')
})

test('V-13 vouchers: used above max_uses, percent and max_uses out of range are refused', async () => {
  const s = await seedEvent()
  const v = await voucher(s, { max_uses: 1 })
  assert.equal(v.used, 0)
  await expectCode(db()`update public.vouchers set used = 2 where id = ${v.id}`, '23514', 'used > max_uses')
  await expectCode(db()`update public.vouchers set used = -1 where id = ${v.id}`, '23514', 'used < 0')
  for (const [over, what] of [
    [{ percent: 0 }, 'percent 0'], [{ percent: 101 }, 'percent 101'],
    [{ max_uses: 0 }, 'max_uses 0'], [{ max_uses: MAX_VOUCHER_USES + 1 }, 'max_uses above 100 000'],
  ]) {
    await expectCode(db()`insert into public.vouchers ${db()(voucherRow(s, over))}`, '23514', what)
  }
  const top = await voucher(s, { max_uses: MAX_VOUCHER_USES, percent: 100 })
  assert.equal(top.max_uses, MAX_VOUCHER_USES)
})

test('V-13 a code is stored upper case and unique per event: leszy15 next to LESZY15 is refused', async () => {
  const s = await seedEvent()
  const other = await seedEvent()
  await voucher(s, { code: 'LESZY15' })
  await expectCode(db()`insert into public.vouchers ${db()(voucherRow(s, { code: 'leszy15' }))}`, '23514', 'lower case code')
  await expectCode(db()`insert into public.vouchers ${db()(voucherRow(s, { code: 'LESZY15' }))}`, '23505', 'the same code twice')
  for (const bad of ['ŁOŚ1', 'AB', 'A'.repeat(33), '----', 'LESZY 15']) {
    await expectCode(db()`insert into public.vouchers ${db()(voucherRow(s, { code: bad }))}`, '23514', `code ${bad}`)
  }
  // Another event may use the same code.
  await voucher(other, { code: 'LESZY15' })
})

test('V-13 transfer_fee and a transfer fee other than 0 are refused; transfer settings default off', async () => {
  const s = await seedEvent()
  const [rs] = await db()`select transfer_enabled, transfer_until, transfer_fee from public.registration_settings where event_id = ${s.eventId}`
  assert.deepEqual({ ...rs }, { transfer_enabled: false, transfer_until: null, transfer_fee: 0 })
  await expectCode(db()`update public.registration_settings set transfer_fee = 500 where event_id = ${s.eventId}`, '23514', 'transfer_fee 500')
  const reg = await insert('registrations', registrationRow(s))
  await expectCode(db()`insert into public.transfers ${db()({
    registration_id: reg.id, kind: 'runner', to_email: 'nowy@test.local', token_hash: sha(), fee: 500,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  })}`, '23514', 'transfers.fee 500')
})

test('V-13 transfers: one pending per registration, a lower-case address, a token only for a runner transfer', async () => {
  const s = await seedEvent()
  const reg = await insert('registrations', registrationRow(s))
  const expires = new Date(Date.now() + 86400000).toISOString()
  const base = { registration_id: reg.id, kind: 'runner', to_email: 'nowy@test.local', expires_at: expires }
  const first = await insert('transfers', { ...base, token_hash: sha() })
  assert.equal(first.status, 'pending')
  assert.equal(first.fee, 0)
  await expectCode(db()`insert into public.transfers ${db()({ ...base, token_hash: sha() })}`, '23505', 'a second pending transfer')
  await expectCode(db()`insert into public.transfers ${db()({ ...base, token_hash: first.token_hash, status: 'cancelled', cancelled_at: new Date().toISOString() })}`,
    '23505', 'a reused token hash')
  await db()`update public.transfers set status = 'cancelled', cancelled_at = now() where id = ${first.id}`
  await insert('transfers', { ...base, token_hash: sha() })

  const reg2 = await insert('registrations', registrationRow(s))
  const b2 = { ...base, registration_id: reg2.id }
  for (const [row, what] of [
    [{ ...b2, to_email: 'Nowy@Test.local', token_hash: sha() }, 'upper-case address'],
    [{ ...b2, to_email: ' nowy@test.local', token_hash: sha() }, 'untrimmed address'],
    [{ ...b2, token_hash: 'ABC' }, 'a token hash that is not SHA-256 hex'],
    [{ ...b2, token_hash: null }, 'a runner transfer without a token'],
    [{ ...b2, kind: 'organizer', token_hash: sha() }, 'an organizer transfer with a token'],
    [{ ...b2, kind: 'friend', token_hash: sha() }, 'an unknown kind'],
    [{ ...b2, token_hash: sha(), status: 'accepted' }, 'accepted without accepted_at and the new registration'],
    [{ ...b2, token_hash: sha(), status: 'cancelled' }, 'cancelled without cancelled_at'],
    [{ ...b2, token_hash: sha(), to_email: null }, 'a pending transfer without an address'],
    [{ ...b2, token_hash: sha(), expires_at: null }, 'a runner transfer without expires_at'],
  ]) {
    await expectCode(db()`insert into public.transfers ${db()(row)}`, '23514', what)
  }
  // An organizer transfer has no token and no link expiry.
  await insert('transfers', { registration_id: reg2.id, kind: 'organizer', to_email: 'nowy@test.local' })
})

test('V-13 an accepted transfer names its new registration; the old address of a cancelled invite may be erased', async () => {
  const s = await seedEvent()
  const reg = await insert('registrations', registrationRow(s))
  const next = await insert('registrations', registrationRow(s, { status: 'pending_payment' }))
  const t = await insert('transfers', { registration_id: reg.id, kind: 'runner', to_email: 'nowy@test.local', token_hash: sha(),
    expires_at: new Date(Date.now() + 86400000).toISOString() })
  await db()`update public.transfers set status = 'accepted', accepted_at = now(), new_registration_id = ${next.id} where id = ${t.id}`
  const t2 = await insert('transfers', { registration_id: next.id, kind: 'runner', to_email: 'trzeci@test.local', token_hash: sha(),
    expires_at: new Date(Date.now() + 86400000).toISOString() })
  await db()`update public.transfers set status = 'cancelled', cancelled_at = now(), to_email = null where id = ${t2.id}`
  await expectCode(db()`delete from public.registrations where id = ${next.id}`, '23503', 'delete a transferred-to registration')
})

// ---------------------------------------------------------------- foreign keys

test('V-13 registrations.voucher_id and partner_id reference this event\'s vouchers and partners, restrict', async () => {
  const s = await seedEvent()
  const other = await seedEvent()
  const partner = await insert('registration_partners', { event_id: s.eventId, name: 'Sklep Biegowy' })
  const v = await voucher(s, { partner_id: partner.id, max_uses: 2 })
  const foreign = await voucher(other)
  const reg = await insert('registrations', registrationRow(s, { voucher_id: v.id, partner_id: partner.id }))
  await db()`update public.vouchers set used = 1 where id = ${v.id}`

  await expectCode(db()`insert into public.registrations ${db()(registrationRow(s, { voucher_id: foreign.id }))}`, '23503', 'another event\'s voucher')
  await expectCode(db()`insert into public.registrations ${db()(registrationRow(s, { voucher_id: crypto.randomUUID() }))}`, '23503', 'no such voucher')
  await expectCode(db()`insert into public.registrations ${db()(registrationRow(other, { partner_id: partner.id }))}`, '23503', 'another event\'s partner')
  await expectCode(db()`insert into public.vouchers ${db()(voucherRow(other, { partner_id: partner.id }))}`, '23503', 'a voucher with another event\'s partner')
  await expectCode(db()`delete from public.vouchers where id = ${v.id}`, '23503', 'delete a used voucher')
  await expectCode(db()`delete from public.registration_partners where id = ${partner.id}`, '23503', 'delete a partner in use')
  await expectCode(db()`insert into public.registration_partners ${db()({ event_id: s.eventId, name: 'sklep biegowy' })}`, '23505', 'the same partner name')
  await expectCode(db()`insert into public.registration_partners ${db()({ event_id: s.eventId, name: '' })}`, '23514', 'an empty partner name')
  await expectCode(db()`insert into public.registration_partners ${db()({ event_id: s.eventId, name: 'x'.repeat(81) })}`, '23514', 'an 81-character partner name')
  assert.equal(reg.voucher_id, v.id)
})

test('V-13 voucher and extra competitions, variants and order lines: restrict where money depends on them', async () => {
  const s = await seedEvent()
  const v = await voucher(s)
  await insert('voucher_competitions', { voucher_id: v.id, category_id: s.categoryId })
  await expectCode(db()`insert into public.voucher_competitions ${db()({ voucher_id: v.id, category_id: s.categoryId })}`, '23505', 'the same competition twice')
  const extra = await insert('extras', { event_id: s.eventId, name: 'Koszulka', price: 5000, order_until: '2099-01-01' })
  await insert('extra_competitions', { extra_id: extra.id, category_id: s.categoryId })
  const variant = await insert('extra_variants', { extra_id: extra.id, label: 'M', stock: 10 })
  await expectCode(db()`delete from public.extras where id = ${extra.id}`, '23503', 'delete an extra with variants')
  const order = await insert('orders', { event_id: s.eventId, buyer_email: 'k@test.local', entry_total: 0, extras_total: 5000,
    donation: 0, total: 5000, expires_at: new Date(Date.now() + 86400000).toISOString() })
  await insert('order_lines', { order_id: order.id, kind: 'extra', extra_variant_id: variant.id, qty: 1, amount: 5000 })
  await expectCode(db()`delete from public.extra_variants where id = ${variant.id}`, '23503', 'delete a variant on an order line')
  await expectCode(db()`insert into public.order_lines ${db()({ order_id: order.id, kind: 'extra', extra_variant_id: crypto.randomUUID(), qty: 1, amount: 0 })}`,
    '23503', 'an order line naming no variant')
  // A voucher nothing references can be deleted, its competitions with it (ruling 11).
  await db()`delete from public.vouchers where id = ${v.id}`
  vouchersSeen.delete(v.id)
  const [{ n }] = await db()`select count(*)::int as n from public.voucher_competitions where voucher_id = ${v.id}`
  assert.equal(n, 0)
})

test('V-13 registration_uploads accepts the extra kind', async () => {
  const s = await seedEvent()
  await insert('registration_uploads', { event_id: s.eventId, kind: 'extra', path: `${s.eventId}/extra/x.jpg` })
  await expectCode(db()`insert into public.registration_uploads ${db()({ event_id: s.eventId, kind: 'mapa', path: 'x' })}`, '23514', 'an unknown kind')
})

test('V-13 every foreign key on the new tables and the new ones on registrations and order_lines is indexed', async () => {
  const fks = await db()`
    select c.conname, c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and (c.conrelid = any (${NEW_TABLES.map((t) => `public.${t}`)}::regclass[])
            or (c.conrelid = 'public.registrations'::regclass and a.attname in ('voucher_id', 'partner_id'))
            or (c.conrelid = 'public.order_lines'::regclass and a.attname = 'extra_variant_id'))`
  const named = (tbl, col) => fks.find((f) => f.tbl === tbl && f.col === col)
  for (const [tbl, col, rule] of [
    ['registrations', 'voucher_id', 'r'], ['registrations', 'partner_id', 'r'], ['order_lines', 'extra_variant_id', 'r'],
    ['vouchers', 'partner_id', 'r'], ['extra_variants', 'extra_id', 'r'], ['transfers', 'registration_id', 'r'],
    ['transfers', 'new_registration_id', 'r'],
  ]) {
    assert.equal(named(tbl, col)?.confdeltype, rule, `${tbl}.${col} is not ON DELETE RESTRICT`)
  }
  const unindexed = []
  for (const fk of fks) {
    const [{ n }] = await db()`
      select count(*)::int as n from pg_index i
        join pg_constraint c on c.conname = ${fk.conname} and c.conrelid = i.indrelid
       where i.indkey[0] = c.conkey[1]`
    if (n === 0) unindexed.push(`${fk.tbl}.${fk.col}`)
  }
  assert.deepEqual(unindexed, [])
  const idx = await db()`select tablename, indexdef from pg_indexes where schemaname = 'public' and tablename in ('vouchers', 'transfers')`
  assert.ok(idx.some((i) => i.tablename === 'vouchers' && /\(event_id\)/.test(i.indexdef)), 'vouchers(event_id)')
  assert.ok(idx.some((i) => i.tablename === 'transfers' && /\(registration_id\)$/.test(i.indexdef) && !/WHERE/.test(i.indexdef)), 'transfers(registration_id)')
})

// ---------------------------------------------------------------- the captain moves with a transfer

test('V-13 a transfer can repoint a team\'s captain: the team stays when the old captain leaves live', async () => {
  const s = await seedEvent()
  await db()`update public.competitions set kind = 'team', team_min = 2, team_max = 5 where category_id = ${s.categoryId}`
  const team = await insert('teams', { event_id: s.eventId, category_id: s.categoryId, name: `Wilki ${s.tag}` })
  const oldCaptain = await insert('registrations', registrationRow(s, { team_id: team.id }))
  await insert('registrations', registrationRow(s, { team_id: team.id }))
  await db()`update public.teams set captain_registration_id = ${oldCaptain.id} where id = ${team.id}`
  const newCaptain = await insert('registrations', registrationRow(s, { team_id: team.id }))

  await db().begin(async (tx) => {
    await tx`update public.teams set captain_registration_id = ${newCaptain.id} where id = ${team.id}`
    await tx`update public.registrations set status = 'transferred_out' where id = ${oldCaptain.id}`
  })
  const [after1] = await db()`select captain_registration_id, released_at from public.teams where id = ${team.id}`
  assert.deepEqual({ ...after1 }, { captain_registration_id: newCaptain.id, released_at: null })
  // The trigger follows the new captain.
  await db()`update public.registrations set status = 'cancelled' where id = ${newCaptain.id}`
  const [after2] = await db()`select released_at from public.teams where id = ${team.id}`
  assert.ok(after2.released_at, 'released with the new captain')
})
