import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statuteUrl } from '../src/scrapers/sources/dostartu.js'

test('a statute file path is made absolute', () => {
  // The API returns statuteFilePl as a bare path. Stored as-is it is not a URL
  // at all, so run-enrich-from-regulamin cannot fetch it and the race keeps no
  // price, no deadline and no distances. 13 future rows were in that state on
  // 2026-09-29. Verified against source_id 17343 on that date: the absolute
  // form answers 200 application/pdf with no redirect, and the document is the
  // regulamin of "36 ZŁOTA MILA CZĘSTOCHOWY", 2 października 2026.
  assert.equal(
    statuteUrl({ statuteFilePl: 'statute_files/17343_pl.pdf' }),
    'https://dostartu.pl/statute_files/17343_pl.pdf'
  )
})

test('a leading slash does not become a double slash', () => {
  assert.equal(
    statuteUrl({ statuteFilePl: '/statute_files/17343_pl.pdf' }),
    'https://dostartu.pl/statute_files/17343_pl.pdf'
  )
})

test('an external statute link is left exactly as the organizer published it', () => {
  // statuteLinkPl still wins: it is a real PDF on the organizer's own server,
  // where the dostartu-hosted copy is sometimes an SPA shell.
  assert.equal(
    statuteUrl({ statuteLinkPl: 'https://klub.pl/regulamin.pdf', statuteFilePl: 'statute_files/1_pl.pdf' }),
    'https://klub.pl/regulamin.pdf'
  )
  assert.equal(statuteUrl({ statuteLinkPl: 'http://klub.pl/regulamin.pdf' }), 'http://klub.pl/regulamin.pdf')
})

test('a protocol-relative statute file keeps its own host', () => {
  assert.equal(statuteUrl({ statuteFilePl: '//cdn.dostartu.pl/x.pdf' }), 'https://cdn.dostartu.pl/x.pdf')
})

test('no statute at all is null', () => {
  assert.equal(statuteUrl({}), null)
  assert.equal(statuteUrl({ statuteFilePl: '' }), null)
  assert.equal(statuteUrl({ statuteFilePl: '   ' }), null)
  assert.equal(statuteUrl(), null)
})
