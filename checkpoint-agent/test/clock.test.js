import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listLanIps, listLanIpsWithIface, detectLanIp } from '../src/clock.js'

// Can't assert exact IPs (CI/dev-box network varies) — just assert the
// shape and that it never throws.
test('listLanIps returns an array of address strings and does not throw', () => {
  const ips = listLanIps()
  assert.ok(Array.isArray(ips))
  for (const ip of ips) assert.equal(typeof ip, 'string')
})

test('detectLanIp stays consistent with the first entry of listLanIps (or null when empty)', () => {
  const ips = listLanIps()
  const detected = detectLanIp()
  if (ips.length === 0) {
    assert.equal(detected, null)
  } else {
    assert.equal(detected, ips[0])
  }
})

// index.js's startup printout uses this instead of re-implementing the
// IPv4/non-internal filter itself — same addresses as listLanIps(), each
// paired with its interface name.
test('listLanIpsWithIface returns {address, iface} pairs matching listLanIps()', () => {
  const pairs = listLanIpsWithIface()
  assert.ok(Array.isArray(pairs))
  for (const p of pairs) {
    assert.equal(typeof p.address, 'string')
    assert.equal(typeof p.iface, 'string')
  }
  assert.deepEqual(pairs.map((p) => p.address), listLanIps())
})
