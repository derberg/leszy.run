// SEC-1: the caller's IP for rate limits and audit rows. A direct caller of
// <project>.supabase.co/functions/v1/* writes every x-forwarded-for element it sends; only what the
// platform appends (cf-connecting-ip, the right-most element) is the real peer. Browsers come through
// the Vercel /edge route, which sets x-leszy-edge to EDGE_PROXY_SECRET; only then is the address
// Vercel vouches for trusted. With no secret configured, the function behaves as before (left-most).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { clientIp, peerIp, EDGE_HEADER } from '../../../supabase/functions/_shared/clientIp.js'

const req = (headers) => ({ headers: { get: (k) => headers[k.toLowerCase()] ?? null } })
const SECRET = 'test-edge-secret-0123456789'
const on = { secret: SECRET }

test('SEC-1 peerIp is what the platform appended, never a forged left-most element', () => {
  assert.equal(peerIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7', 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7')
  assert.equal(peerIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 198.51.100.7' })), '198.51.100.7')
  assert.equal(peerIp(req({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': 'junk' })), '198.51.100.7')
  assert.equal(peerIp(req({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8::1')
  assert.equal(peerIp(req({})), null)
})

test('SEC-1 with no EDGE_PROXY_SECRET configured, clientIp is exactly what main read: the left-most element', async () => {
  const off = { secret: '' }
  assert.equal(await clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), off), '203.0.113.9')
  assert.equal(await clientIp(req({ 'x-forwarded-for': '2001:db8::1' }), off), '2001:db8::1')
  assert.equal(await clientIp(req({ 'x-forwarded-for': 'not-an-ip, 10.0.0.1' }), off), null)
  assert.equal(await clientIp(req({}), off), null)
  // The header means nothing while no secret exists.
  assert.equal(await clientIp(req({ 'x-forwarded-for': '6.6.6.6, 10.0.0.1', [EDGE_HEADER]: '' }), off), '6.6.6.6')
})

test('SEC-1 a direct caller (no or wrong proxy header) is keyed on the peer, whatever it forges', async () => {
  const forged = (xff, extra = {}) => req({ 'x-forwarded-for': `${xff}, 198.51.100.7`, 'cf-connecting-ip': '198.51.100.7', ...extra })
  assert.equal(await clientIp(forged('1.2.3.4'), on), '198.51.100.7')
  assert.equal(await clientIp(forged('9.9.9.9, 8.8.8.8'), on), '198.51.100.7', 'multiple forged hops')
  assert.equal(await clientIp(forged('1.2.3.4', { [EDGE_HEADER]: 'guess' }), on), '198.51.100.7', 'wrong secret')
  assert.equal(await clientIp(forged('1.2.3.4', { [EDGE_HEADER]: SECRET.slice(0, -1) }), on), '198.51.100.7')
  assert.equal(await clientIp(req({}), on), null)
})

test('SEC-1 through the /edge route (secret matches): the browser address Vercel set, left of the peer', async () => {
  const viaEdge = (xff, peer = '76.76.21.21') =>
    req({ 'x-forwarded-for': xff, 'cf-connecting-ip': peer, [EDGE_HEADER]: SECRET })
  assert.equal(await clientIp(viaEdge('203.0.113.9, 76.76.21.21'), on), '203.0.113.9')
  assert.equal(await clientIp(viaEdge('2001:db8::5, 76.76.21.21'), on), '2001:db8::5')
  // No element left of the peer: x-vercel-forwarded-for, then the peer itself.
  assert.equal(await clientIp(req({ 'x-forwarded-for': '76.76.21.21', 'x-vercel-forwarded-for': '203.0.113.10', [EDGE_HEADER]: SECRET }), on), '203.0.113.10')
  assert.equal(await clientIp(viaEdge('76.76.21.21'), on), '76.76.21.21')
})

test('SEC-1 nothing outside _shared/clientIp.js reads an IP header', () => {
  const root = new URL('../../../supabase/functions/', import.meta.url).pathname
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== 'tests' && name !== 'node_modules') walk(p); continue }
      if (!p.endsWith('.js') || p.endsWith('/_shared/clientIp.js')) continue
      if (/get\(\s*['"](x-forwarded-for|cf-connecting-ip|x-real-ip|x-vercel-forwarded-for)['"]/i.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length))
    }
  }
  walk(root)
  assert.deepEqual(offenders, [])
})

test('SEC-1 the /edge route sets the proxy header from the Vercel env, after deleting any the client sent', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../../public/vercel.json', import.meta.url), 'utf8'))
  assert.ok(!(vercel.rewrites ?? []).some((r) => r.source.startsWith('/edge')), 'no plain /edge rewrite left')
  const route = (vercel.routes ?? []).find((r) => r.src.startsWith('/edge'))
  assert.ok(route, 'an /edge route')
  assert.match(route.dest, /^https:\/\/[a-z]+\.supabase\.co\/functions\/v1\/\$1$/)
  const [del, set] = route.transforms
  assert.deepEqual(del, { type: 'request.headers', op: 'delete', target: { key: EDGE_HEADER } })
  assert.deepEqual(set, { type: 'request.headers', op: 'set', target: { key: EDGE_HEADER }, args: '$EDGE_PROXY_SECRET', env: ['EDGE_PROXY_SECRET'] })
})

test('SEC-1 (Plan 7 final review C-1) every clientIp() call is awaited: it returns a Promise since #333', () => {
  const root = new URL('../../../supabase/functions/', import.meta.url).pathname
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== 'tests' && name !== 'node_modules') walk(p); continue }
      if (!p.endsWith('.js') || p.endsWith('/_shared/clientIp.js')) continue
      // Comments name the function too; only code is checked.
      const src = readFileSync(p, 'utf8').split('\n').map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l)).join('\n')
      for (const m of src.matchAll(/(^|[^\w.])clientIp\(/g)) {
        const before = src.slice(Math.max(0, m.index - 8), m.index + m[1].length)
        if (!/await\s*\(?\s*$/.test(before)) offenders.push(`${p.slice(root.length)}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [])
})
