import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRegulaminScope } from '../scripts/lib/enrichScope.js'

const TODAY = '2026-09-29'

test('the default scope does not gate on merged_at', () => {
  // The regression. run-enrich-from-regulamin.js is hand-run and nothing
  // schedules it, so a default of "merged today" strands every row the
  // operator does not mine on its merge day. On 2026-09-29 that was 124 future
  // rows across 17 sources, reaching back to 2026-03-28, among them
  // BIEG PAŹDZIERNIKOWY 2026 - GMINA ŁUBIANKA, whose regulamin states the fee.
  const scope = resolveRegulaminScope({ argv: [], today: TODAY })
  assert.equal(scope.mergedSince, null)
})

test('the default scope skips races that already happened', () => {
  // Un-mined rows are dominated by past races: 1341 of 1465 on 2026-09-29.
  // Their fees help nobody and each one costs a model call.
  const scope = resolveRegulaminScope({ argv: [], today: TODAY })
  assert.equal(scope.minDate, TODAY)
})

test('--merged-since keeps the narrow scope for a same-run pairing', () => {
  const scope = resolveRegulaminScope({ argv: ['--merged-since', '2026-09-28'], today: TODAY })
  assert.equal(scope.mergedSince, '2026-09-28')
  assert.equal(scope.minDate, TODAY)
})

test('--merged-since rejects anything that is not a date', () => {
  assert.throws(
    () => resolveRegulaminScope({ argv: ['--merged-since', 'yesterday'], today: TODAY }),
    /--merged-since expects YYYY-MM-DD/
  )
  assert.throws(
    () => resolveRegulaminScope({ argv: ['--merged-since'], today: TODAY }),
    /--merged-since expects YYYY-MM-DD/
  )
})

test('--all drops the date floor as well', () => {
  const scope = resolveRegulaminScope({ argv: ['--all'], today: TODAY })
  assert.equal(scope.minDate, null)
  assert.equal(scope.mergedSince, null)
})

test('--limit bounds a catch-up run', () => {
  assert.equal(resolveRegulaminScope({ argv: ['--limit', '20'], today: TODAY }).limit, 20)
  assert.equal(resolveRegulaminScope({ argv: [], today: TODAY }).limit, null)
})

test('--limit rejects a value that is not a positive whole number', () => {
  for (const bad of ['0', '-3', 'abc', '2.5']) {
    assert.throws(
      () => resolveRegulaminScope({ argv: ['--limit', bad], today: TODAY }),
      /--limit expects a positive whole number/,
      bad
    )
  }
})

test('the description says which scope is in force', () => {
  assert.match(resolveRegulaminScope({ argv: [], today: TODAY }).description, /un-mined/)
  assert.match(resolveRegulaminScope({ argv: ['--all'], today: TODAY }).description, /past/)
  assert.match(
    resolveRegulaminScope({ argv: ['--merged-since', '2026-09-28'], today: TODAY }).description,
    /2026-09-28/
  )
})
