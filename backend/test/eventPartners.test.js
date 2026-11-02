import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { partnerName, partnerNote, partnerUrl } from '../src/lib/partnerFields.js'
import * as edge from '../../supabase/functions/_shared/registration/partners.js'
import { eventPartnersRoutes } from '../src/routes/eventPartners.js'

test('partner fields: backend validators answer like the edge ones', () => {
  const inputs = [undefined, null, '', '  ', ' Ala ', 'x'.repeat(80), 'x'.repeat(81), 'x'.repeat(500), 'x'.repeat(501),
    'https://a.pl', ' http://a.pl/x ', 'HTTPS://A.PL', 'javascript:x', 'ftp://a.pl', 'https://a b', 'https://' + 'a'.repeat(493),
    'https://' + 'a'.repeat(492), 5, {}, [], true]
  for (const v of inputs) {
    assert.deepEqual(partnerName(v), edge.partnerName(v), `name ${JSON.stringify(v)}`)
    assert.deepEqual(partnerNote(v), edge.partnerNote(v), `note ${JSON.stringify(v)}`)
    assert.deepEqual(partnerUrl(v), edge.partnerUrl(v), `url ${JSON.stringify(v)}`)
  }
})

// A minimal stub of the supabase query builder: records updates, answers a fixed row.
function stubClient(row, opts = {}) {
  const calls = { updates: [], inserts: [], removed: [] }
  const builder = (table) => {
    const b = {
      select() { return b }, eq() { return b }, order() { return b },
      update(u) { calls.updates.push(u); return b },
      insert(r) { calls.inserts.push(r); return b },
      delete() { return b },
      single: async () => (opts.error ? { data: null, error: opts.error } : { data: { ...row, ...(calls.updates.at(-1) || {}) }, error: null }),
    }
    return b
  }
  return {
    calls,
    from: builder,
    storage: { from: () => ({ remove: async (p) => { calls.removed.push(p); return {} },
      upload: async () => ({ error: null }), getPublicUrl: (p) => ({ data: { publicUrl: `https://x/storage/v1/object/public/partner-logos/${p}` } }) }) },
  }
}

async function app(client) {
  const f = Fastify()
  await f.register(eventPartnersRoutes, { client })
  return f
}

test('PATCH partner: javascript: website is a 400', async () => {
  const f = await app(stubClient({ id: 'p' }))
  const r = await f.inject({ method: 'PATCH', url: '/partners/p', payload: { website_url: 'javascript:x' } })
  assert.equal(r.statusCode, 400)
  assert.ok(JSON.parse(r.body).error)
})

test('PATCH partner: unknown field is a 400', async () => {
  const f = await app(stubClient({ id: 'p' }))
  const r = await f.inject({ method: 'PATCH', url: '/partners/p', payload: { logo_url: 'x' } })
  assert.equal(r.statusCode, 400)
})

test('PATCH partner: duplicate name is a 409', async () => {
  const f = await app(stubClient({ id: 'p' }, { error: { code: '23505', message: 'dup' } }))
  const r = await f.inject({ method: 'PATCH', url: '/partners/p', payload: { name: 'A' } })
  assert.equal(r.statusCode, 409)
  assert.equal(JSON.parse(r.body).error, 'Taki partner już istnieje.')
})

test('PATCH partner: a name edit leaves a legacy SVG logo untouched', async () => {
  const c = stubClient({ id: 'p', logo_url: 'https://x/storage/v1/object/public/partner-logos/p/a.svg' })
  const f = await app(c)
  const r = await f.inject({ method: 'PATCH', url: '/partners/p', payload: { name: ' Nowa ', note: 'n', is_public: false } })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(Object.keys(c.calls.updates[0]).sort(), ['is_public', 'name', 'note', 'updated_at'])
  assert.equal(c.calls.updates[0].name, 'Nowa')
  assert.equal(JSON.parse(r.body).data.logo_url.endsWith('a.svg'), true)
  assert.deepEqual(c.calls.removed, [])
})

test('POST partner: invalid note and url are 400s', async () => {
  const f = await app(stubClient({}))
  const r1 = await f.inject({ method: 'POST', url: '/events/e/partners', payload: { name: 'A', note: 'x'.repeat(501) } })
  assert.equal(r1.statusCode, 400)
  const r2 = await f.inject({ method: 'POST', url: '/events/e/partners', payload: { name: 'A', website_url: 'ftp://a' } })
  assert.equal(r2.statusCode, 400)
  const r3 = await f.inject({ method: 'POST', url: '/events/e/partners', payload: { name: '  ' } })
  assert.equal(r3.statusCode, 400)
})
