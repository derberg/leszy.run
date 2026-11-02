// Event partners, task 1: one `event_partners` table serves the admin app, the wizard and the
// discount codes. `registration_partners` is gone; its rows were copied (hidden) or merged into
// the admin partner of the same name by migration 20261108200000. That copy runs once in
// production and no test here can reach the state before it: it was checked by hand (task-1
// report). LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { admin, authenticatedClient, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { one, profileFor, rpc } from './helpers/orders.js'
import { BIEG, DZIECI } from './helpers/groups.js'
import { vouchersMade } from './helpers/cart.js'
import { accept, enableTransfers, inviteOk, paidEntry } from './helpers/transfers.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'

let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
after(async () => { if (sqlClient) await sqlClient.end() })
afterEach(async () => {
  const ids = [...vouchersMade]
  vouchersMade.clear()
  for (const id of ids) await assertVoucherInvariant(id)
})

function anon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function insert(table, row) {
  const { data, error } = await admin().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

/** A draft registration event with one competition. */
async function seedEvent() {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `Partnerzy ${tag}`, slug: `partnerzy-${tag}` })
  await insert('registration_settings', { event_id: event.id, club_id: ZT_CLUB })
  const category = await insert('categories', { event_id: event.id, name: '10 km', slug: `10km-${tag}` })
  await insert('competitions', { category_id: category.id, event_id: event.id, name: '10 km', capacity: 10, sort_order: 0 })
  return { eventId: event.id, categoryId: category.id }
}

const partnerRow = (eventId, over = {}) => ({ event_id: eventId, name: `Sklep ${crypto.randomBytes(3).toString('hex')}`, ...over })

async function expectCode(promise, code, what) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code} ${err.message}`)
    return true
  }, what)
}

// ---------------------------------------------------------------- schema

test('event_partners carries note, is_public and logo_path; registration_partners is gone; names are unique per event in any case', async () => {
  const cols = await sql()`
    select column_name, column_default, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'event_partners'`
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]))
  for (const c of ['note', 'is_public', 'logo_path']) assert.ok(byName[c], `column ${c}`)
  assert.equal(byName.is_public.is_nullable, 'NO')
  assert.equal(byName.is_public.column_default, 'true')
  const [{ gone }] = await sql()`select to_regclass('public.registration_partners') is null as gone`
  assert.equal(gone, true, 'registration_partners dropped')

  const { eventId } = await seedEvent()
  const first = await insert('event_partners', { event_id: eventId, name: 'Sklep X' })
  assert.equal(first.is_public, true, 'a new partner is public unless told otherwise')
  await expectCode(sql()`insert into public.event_partners ${sql()({ event_id: eventId, name: 'sklep x' })}`, '23505', 'the same name in another case')
  // Another event may use the same name.
  const other = await seedEvent()
  await insert('event_partners', { event_id: other.eventId, name: 'Sklep X' })

  await expectCode(sql()`insert into public.event_partners ${sql()({ event_id: eventId, name: '' })}`, '23514', 'an empty name')
  await expectCode(sql()`insert into public.event_partners ${sql()({ event_id: eventId, name: ' Sklep Y' })}`, '23514', 'an untrimmed name')
  await expectCode(sql()`insert into public.event_partners ${sql()({ event_id: eventId, name: 'x'.repeat(81) })}`, '23514', 'an 81-character name')
  await expectCode(sql()`insert into public.event_partners ${sql()(partnerRow(eventId, { note: 'n'.repeat(501) }))}`, '23514', 'a 501-character note')
  await insert('event_partners', partnerRow(eventId, { name: 'y'.repeat(80), note: 'n'.repeat(500) }))
})

test('website_url is NULL or an http(s) address of at most 500 characters', async () => {
  const { eventId } = await seedEvent()
  await expectCode(sql()`insert into public.event_partners ${sql()(partnerRow(eventId, { website_url: 'javascript:alert(1)' }))}`, '23514', 'javascript:')
  await expectCode(sql()`insert into public.event_partners ${sql()(partnerRow(eventId, { website_url: 'ftp://sklep.pl' }))}`, '23514', 'ftp:')
  await expectCode(sql()`insert into public.event_partners ${sql()(partnerRow(eventId, { website_url: `https://${'a'.repeat(493)}.pl` }))}`, '23514', 'a 501-character address')
  for (const url of [null, 'http://sklep.pl', 'HTTPS://Sklep.pl/x']) {
    const p = await insert('event_partners', partnerRow(eventId, { website_url: url }))
    assert.equal(p.website_url, url)
  }
})

test('vouchers.partner_id and registrations.partner_id reference event_partners (id, event_id), restrict', async () => {
  const fks = await sql()`
    select conname, confrelid::regclass::text as target, confdeltype from pg_constraint
     where conname in ('vouchers_partner_id_fkey', 'registrations_partner_id_fkey') order by conname`
  assert.deepEqual(fks.map((f) => [f.conname, f.target, f.confdeltype]), [
    ['registrations_partner_id_fkey', 'event_partners', 'r'],
    ['vouchers_partner_id_fkey', 'event_partners', 'r'],
  ])
  const [{ ok: pairKey }] = await sql()`
    select exists (select 1 from pg_constraint where conrelid = 'public.event_partners'::regclass and contype = 'u'
                    and pg_get_constraintdef(oid) = 'UNIQUE (id, event_id)') as ok`
  assert.equal(pairKey, true, 'UNIQUE (id, event_id)')

  const s = await seedEvent()
  const other = await seedEvent()
  const partner = await insert('event_partners', partnerRow(s.eventId, { is_public: false }))
  const v = await insert('vouchers', { event_id: s.eventId, code: `LESZY-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, percent: 15, max_uses: 1, partner_id: partner.id })
  assert.equal(v.partner_id, partner.id)
  await expectCode(sql()`insert into public.vouchers ${sql()({ event_id: other.eventId, code: 'OBCY-1234', percent: 10, max_uses: 1, partner_id: partner.id })}`,
    '23503', 'another event\'s partner on a voucher')
  await expectCode(sql()`delete from public.event_partners where id = ${partner.id}`, '23503', 'delete a partner a voucher holds')
  await sql()`update public.vouchers set partner_id = null where id = ${v.id}`
  await sql()`delete from public.event_partners where id = ${partner.id}`
})

// ---------------------------------------------------------------- access

test('anon reads only public partners and only their public columns; no client writes', async () => {
  const { eventId } = await seedEvent()
  const shown = await insert('event_partners', partnerRow(eventId, { note: 'tajne', website_url: 'https://sklep.pl', sort_order: 1 }))
  await insert('event_partners', partnerRow(eventId, { is_public: false, note: 'ukryty' }))
  for (const [who, client] of [['anon', anon()], ['authenticated', authenticatedClient()]]) {
    const { data, error } = await client.from('event_partners').select('id,event_id,name,logo_url,website_url,sort_order').eq('event_id', eventId)
    assert.equal(error, null, `${who}: ${error?.message}`)
    assert.deepEqual(data, [{ id: shown.id, event_id: eventId, name: shown.name, logo_url: null, website_url: 'https://sklep.pl', sort_order: 1 }], who)
    for (const col of ['note', 'is_public', 'logo_path', 'created_at', '*']) {
      const r = await client.from('event_partners').select(col).eq('event_id', eventId)
      assert.ok(r.error, `${who} read ${col}: ${JSON.stringify(r.data)}`)
      assert.match(r.error.message, /permission denied/, `${who} ${col}: ${r.error.message}`)
    }
    const w = await client.from('event_partners').insert(partnerRow(eventId))
    assert.ok(w.error, `${who} inserted`)
  }
})

test('anon cannot list partner-logos; the bucket is public, so an object is served by its URL', async () => {
  const { data: bucket } = await admin().storage.getBucket('partner-logos')
  assert.equal(bucket?.public, true, 'bucket partner-logos exists and is public')
  const name = `${crypto.randomUUID()}.png`
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const up = await admin().storage.from('partner-logos').upload(name, png, { contentType: 'image/png' })
  assert.equal(up.error, null, up.error?.message)
  try {
    const { data, error } = await anon().storage.from('partner-logos').list()
    assert.equal(error, null, error?.message)
    assert.deepEqual(data, [])
    const res = await fetch(`${localEnv().url}/storage/v1/object/public/partner-logos/${name}`)
    assert.equal(res.status, 200)
  } finally {
    await admin().storage.from('partner-logos').remove([name])
  }
})

// ---------------------------------------------------------------- RPCs

test('create_vouchers, update_voucher, set_registration_partner and apply_transfer take an event_partners id', async () => {
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  const owner = await sessionFor('owner@zatyrani-test.local')
  const ownerId = await profileFor('owner@zatyrani-test.local')
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), DZIECI()], prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })
  await enableTransfers(event)
  const hidden = await insert('event_partners', partnerRow(event.eventId, { is_public: false }))
  const shown = await insert('event_partners', partnerRow(event.eventId))
  const foreign = await insert('event_partners', partnerRow((await seedEvent()).eventId))

  const code = `PART-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  const made = await rpc('create_vouchers', {
    p_event_id: event.eventId, p_items: [{ code, percent: 15, max_uses: 5, partner_id: hidden.id }], p_actor: ownerId,
  })
  assert.equal(made.error, null, made.error?.message)
  assert.equal(made.data, 1)
  const refused = await rpc('create_vouchers', {
    p_event_id: event.eventId, p_items: [{ code: `${code}-X`, percent: 15, max_uses: 5, partner_id: foreign.id }], p_actor: ownerId,
  })
  assert.equal(refused.error?.message, 'invalid_partner')
  const v = await one('vouchers', { event_id: event.eventId, code })
  vouchersMade.add(v.id)
  assert.equal(v.partner_id, hidden.id)

  const upd = await rpc('update_voucher', { p_voucher_id: v.id, p_fields: { partner_id: shown.id }, p_actor: ownerId })
  assert.equal(upd.error, null, upd.error?.message)
  assert.deepEqual(upd.data, { changed: ['partner_id'] })
  const updForeign = await rpc('update_voucher', { p_voucher_id: v.id, p_fields: { partner_id: foreign.id }, p_actor: ownerId })
  assert.equal(updForeign.error?.message, 'invalid_partner')

  const a = await paidEntry(event, { voucher: { code }, displayed: 5100 })
  assert.equal(a.reg.partner_id, shown.id, 'the voucher\'s partner is copied onto the entry')
  const set = await rpc('set_registration_partner', { p_registration_id: a.reg.id, p_partner_id: hidden.id, p_actor: ownerId })
  assert.equal(set.error, null, set.error?.message)
  assert.deepEqual(set.data, { partnerId: hidden.id, changed: true })
  const setForeign = await rpc('set_registration_partner', { p_registration_id: a.reg.id, p_partner_id: foreign.id, p_actor: ownerId })
  assert.equal(setForeign.error?.message, 'invalid_partner')

  // accept_transfer → apply_transfer, which locks the entry's partner row.
  const t = await inviteOk(a.reg.id, a.profileId)
  const out = await accept(event, t.hash)
  assert.equal(out.error, null, out.error?.message)
  const fresh = await one('registrations', { id: out.data.registrationId })
  assert.equal(fresh.partner_id, hidden.id, 'the partner moves with the package')
})
