// ?from= after login must stay on this site. Browsers strip tab/newline before
// parsing, so `/\t/evil.com` used to pass and land on https://evil.com/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeFromPath } from '../../src/lib/safeFrom.js'

const ORIGIN = 'https://www.leszy.run'

test('control characters and scheme-relative paths are refused', () => {
  for (const bad of ['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\u0000x', '/a b', '//evil.com', '/\\evil.com', 'https://evil.com', '/../x', '', null, 42]) {
    assert.equal(safeFromPath(bad, ORIGIN), null, JSON.stringify(bad))
  }
})

test('the raw tab form really does leave the site, which is why it is refused', () => {
  assert.equal(new URL('/\t/evil.com', ORIGIN).origin, 'https://evil.com')
})

test('a percent-encoded tab stays on the site and is kept', () => {
  assert.equal(new URL('/%09/evil.com', ORIGIN).origin, ORIGIN)
  assert.equal(safeFromPath('/%09/evil.com', ORIGIN), '/%09/evil.com')
})

test('ordinary internal paths pass', () => {
  assert.equal(safeFromPath('/ok/path?x=1', ORIGIN), '/ok/path?x=1')
  assert.equal(safeFromPath('/klub/abc/dolacz?kod=XYZ', ORIGIN), '/klub/abc/dolacz?kod=XYZ')
})

test('no origin to check against means no redirect', () => {
  assert.equal(safeFromPath('/ok', ''), null)
})
