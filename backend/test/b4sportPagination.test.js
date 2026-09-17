import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginateListing } from '../src/scrapers/sources/b4sport.js'

// b4sport's listing sets exceededLimit on a page that still carries events and
// keeps serving events after it. Measured 2026-09-17, the flag turned true on
// the page at offset 40, offset 50 still held Bolesławiec Run and XV Maraton
// Wigry 2027, and the listing only ran dry at offset 60.
function fakeListing(pages) {
  return async url => pages[url] || null
}

test('exceededLimit does not end the listing', async () => {
  const pages = {
    '/offset/10': { events: '<div>a</div>', nextUrl: '/offset/20' },
    '/offset/20': { events: '<div>b</div>', nextUrl: '/offset/30', exceededLimit: true },
    '/offset/30': { events: '<div>c</div>', nextUrl: '/offset/40', exceededLimit: true },
    '/offset/40': { events: '', nextUrl: '/offset/50', exceededLimit: true },
  }
  const seen = []
  await paginateListing({
    firstUrl: '/offset/10',
    fetchPage: fakeListing(pages),
    onFragment: fragment => seen.push(fragment),
    delayMs: 0,
  })

  assert.deepEqual(seen, ['<div>a</div>', '<div>b</div>', '<div>c</div>'])
})

test('an empty fragment ends the listing even when nextUrl continues', async () => {
  const pages = {
    '/offset/10': { events: '<div>a</div>', nextUrl: '/offset/20' },
    '/offset/20': { events: '   ', nextUrl: '/offset/30' },
    '/offset/30': { events: '<div>never reached</div>', nextUrl: null },
  }
  const seen = []
  await paginateListing({
    firstUrl: '/offset/10',
    fetchPage: fakeListing(pages),
    onFragment: fragment => seen.push(fragment),
    delayMs: 0,
  })

  assert.deepEqual(seen, ['<div>a</div>'])
})

test('a page that fails to parse ends the listing', async () => {
  const pages = {
    '/offset/10': { events: '<div>a</div>', nextUrl: '/offset/20' },
    // '/offset/20' missing → fetchPage returns null, as it does on bad JSON
  }
  const seen = []
  await paginateListing({
    firstUrl: '/offset/10',
    fetchPage: fakeListing(pages),
    onFragment: fragment => seen.push(fragment),
    delayMs: 0,
  })

  assert.deepEqual(seen, ['<div>a</div>'])
})

test('maxPages caps a listing that never ends', async () => {
  const seen = []
  await paginateListing({
    firstUrl: '/offset/10',
    fetchPage: async () => ({ events: '<div>x</div>', nextUrl: '/offset/10' }),
    onFragment: fragment => seen.push(fragment),
    maxPages: 3,
    delayMs: 0,
  })

  assert.equal(seen.length, 3)
})
