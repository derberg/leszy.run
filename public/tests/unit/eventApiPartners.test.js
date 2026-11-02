import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../../api/event.js'

// /api/event reads registration_public(), then the event's public partners by event id.
// Supabase is stubbed at the fetch level, so the real client builds the requests.
process.env.VITE_SUPABASE_URL = 'http://supabase.test'
process.env.VITE_SUPABASE_ANON_KEY = 'anon'

const realFetch = globalThis.fetch
let partnerRows, partnerStatus, calls

beforeEach(() => {
  calls = []
  partnerStatus = 200
  partnerRows = [
    { id: 'p1', event_id: 'ev1', name: 'Sklep X', logo_url: 'https://x/l.png', website_url: 'https://x.pl', sort_order: 0 },
    { id: 'p2', event_id: 'ev1', name: 'Bez logo', logo_url: null, website_url: null, sort_order: 1 },
  ]
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (u.includes('/rpc/registration_public')) return json(200, { eventId: 'ev1', slug: 'bieg', competitions: [], extras: [] })
    if (u.includes('/event_partners')) return partnerStatus === 200 ? json(200, partnerRows) : json(partnerStatus, { message: 'boom' })
    return json(404, {})
  }
})
afterEach(() => { globalThis.fetch = realFetch })

function fakeRes() {
  return { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
}
async function get() {
  const res = fakeRes()
  await handler({ url: '/api/event?slug=bieg', headers: {} }, res)
  return { res, body: JSON.parse(res.body) }
}

describe('api/event partners', () => {
  it('carries the public partners in camelCase, read by event id with only the anon-readable columns', async () => {
    const { res, body } = await get()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(body.partners, [
      { id: 'p1', name: 'Sklep X', logoUrl: 'https://x/l.png', websiteUrl: 'https://x.pl' },
      { id: 'p2', name: 'Bez logo', logoUrl: null, websiteUrl: null },
    ])
    const q = decodeURIComponent(calls.find((c) => c.includes('/event_partners')))
    assert.match(q, /select=id,name,logo_url,website_url,sort_order/)
    assert.match(q, /event_id=eq\.ev1/)
    assert.match(q, /order=sort_order\.asc,id\.asc/)
    assert.ok(!/note|is_public|logo_path/.test(q))
  })

  it('changes the version when a partner name changes', async () => {
    const a = (await get()).body.version
    partnerRows[0].name = 'Sklep Y'
    const b = (await get()).body.version
    assert.notEqual(a, b)
  })

  it('fails the build with 502 and no-store when the partners read errors', async () => {
    partnerStatus = 500
    const { res } = await get()
    assert.equal(res.statusCode, 502)
    assert.equal(res.headers['Cache-Control'], 'no-store')
  })
})
