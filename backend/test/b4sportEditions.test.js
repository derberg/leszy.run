import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editionKey } from '../src/scrapers/sources/b4sport.js'

// An organizer on b4sport reuses one registration form for every edition of a
// series and only changes its date. Sianowska Alfa i Omega ran Sianowska 5 on
// 2026-05-01, 07-18, 09-05 and 12-05 off form 6973, and the Łazy run on
// 2026-08-01 off form 10192, which had been Bajko Run on 05-31. The form id
// was the source_id, so the first edition froze the row and every later one
// was skipped as already known.
const today = '2026-06-20'

test('an unknown form id is a new row under its own id', () => {
  const ev = { source_id: '13001', date: '2026-07-01' }
  assert.deepEqual(editionKey(ev, new Set(), new Map(), today), { sourceId: '13001', known: false, changed: false })
})

test('a known form id on its stored date is skipped', () => {
  const ev = { source_id: '6973', date: '2026-05-01' }
  const rows = new Map([['6973', { source_id: '6973', date: '2026-05-01' }]])
  assert.deepEqual(editionKey(ev, new Set(['6973']), rows, '2026-04-20'), { sourceId: '6973', known: true, changed: false })
})

test('a reused form whose stored edition is over is a new edition row', () => {
  const ev = { source_id: '6973', date: '2026-07-18' }
  const rows = new Map([['6973', { source_id: '6973', date: '2026-05-01' }]])
  assert.deepEqual(editionKey(ev, new Set(['6973']), rows, today), { sourceId: '6973-2026-07-18', known: false, changed: false })
})

test('the edition row is skipped once it is stored', () => {
  const ev = { source_id: '6973', date: '2026-07-18' }
  const rows = new Map([
    ['6973', { source_id: '6973', date: '2026-05-01' }],
    ['6973-2026-07-18', { source_id: '6973-2026-07-18', date: '2026-07-18' }],
  ])
  assert.deepEqual(editionKey(ev, new Set(rows.keys()), rows, today), { sourceId: '6973-2026-07-18', known: true, changed: false })
})

test('a future event that moved its date updates its own row', () => {
  const ev = { source_id: '12000', date: '2026-08-15' }
  const rows = new Map([['12000', { source_id: '12000', date: '2026-08-08' }]])
  assert.deepEqual(editionKey(ev, new Set(['12000']), rows, today), { sourceId: '12000', known: true, changed: true })
})

test('a known id with no stored row keeps the old skip', () => {
  const ev = { source_id: '6973', date: '2026-07-18' }
  assert.deepEqual(editionKey(ev, new Set(['6973']), new Map(), today), { sourceId: '6973', known: true, changed: false })
})
