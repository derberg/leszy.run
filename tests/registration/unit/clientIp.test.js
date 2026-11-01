// SEC-1: the caller's IP for rate limits and audit rows. A direct caller of
// <project>.supabase.co/functions/v1/* controls every x-forwarded-for element it sends; only what
// the platform appends (Cloudflare's cf-connecting-ip, the right-most x-forwarded-for element) is
// the real peer. The per-IP limits used to read the LEFT-most element, so a fresh forged value per
// request reset them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { clientIp, peerIp, ipThrottles } from '../../../supabase/functions/_shared/clientIp.js'

const req = (headers) => ({ headers: { get: (k) => headers[k.toLowerCase()] ?? null } })

test('SEC-1 peerIp is the address the platform appended, never a forged left-most element', () => {
  // A direct caller forges the first element; Cloudflare appends the real peer and sets cf-connecting-ip.
  assert.equal(peerIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7', 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7')
  // No cf-connecting-ip: the right-most element is the one the last proxy appended.
  assert.equal(peerIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 198.51.100.7' })), '198.51.100.7')
  // A forged cf-connecting-ip cannot exist on the platform (Cloudflare overwrites it), but a junk one is ignored.
  assert.equal(peerIp(req({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': 'evil' })), '198.51.100.7')
  assert.equal(peerIp(req({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8::1')
  assert.equal(peerIp(req({})), null)
  assert.equal(peerIp(req({ 'x-forwarded-for': 'not-an-ip' })), null)
})

test('SEC-1 clientIp is the element the proxy in front of the peer vouched for (the browser behind /edge)', () => {
  // Through the Vercel /edge rewrite: Vercel overwrites XFF with the browser, Cloudflare appends Vercel.
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7', 'cf-connecting-ip': '198.51.100.7' })), '203.0.113.9')
  // Multiple hops: only the element immediately left of the peer counts, never the left-most.
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9, 198.51.100.7', 'cf-connecting-ip': '198.51.100.7' })), '203.0.113.9')
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9, 198.51.100.7' })), '203.0.113.9')
  // A direct caller with no forwarded element: the peer itself.
  assert.equal(clientIp(req({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7')
  assert.equal(clientIp(req({ 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7')
  // A junk element left of the peer falls back to the peer rather than keying on arbitrary text.
  assert.equal(clientIp(req({ 'x-forwarded-for': 'junk, 198.51.100.7' })), '198.51.100.7')
  assert.equal(clientIp(req({})), null)
  assert.equal(clientIp(req({ 'x-forwarded-for': '' })), null)
})

test('SEC-1 ipThrottles pairs the per-client limit with a per-peer limit that a forged header cannot reset', () => {
  const opts = { limit: 20, peerLimit: 600, windowSeconds: 3600 }
  const a = ipThrottles(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7', 'cf-connecting-ip': '198.51.100.7' }), 'register-ip', opts)
  const b = ipThrottles(req({ 'x-forwarded-for': '9.9.9.9, 198.51.100.7', 'cf-connecting-ip': '198.51.100.7' }), 'register-ip', opts)
  assert.deepEqual(a, [
    { key: 'register-ip:1.2.3.4', limit: 20, windowSeconds: 3600 },
    { key: 'register-ip-peer:198.51.100.7', limit: 600, windowSeconds: 3600 },
  ])
  assert.equal(a[1].key, b[1].key, 'rotating the forged element leaves the peer counter where it was')
})

test('SEC-1 a missing IP maps to a shared bucket, never to no limit', () => {
  const t = ipThrottles(req({}), 'order-ip', { limit: 20, peerLimit: 600, windowSeconds: 3600 })
  assert.deepEqual(t.map((x) => x.key), ['order-ip:unknown', 'order-ip-peer:unknown'])
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
