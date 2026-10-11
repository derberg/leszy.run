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

// Naming rows is what a fix needs after it merges. The step reads every
// un-mined future row with a regulamin URL, 57 of them on 2026-09-29, and
// orders them soonest race first, so --limit cannot reach a race in 2027. A
// fix measured against ZPGS 2027 (b4sport:13127) therefore had no way to be
// applied to ZPGS 2027 short of paying for all 57.
test('--only names the rows to mine', () => {
  const scope = resolveRegulaminScope({
    argv: ['--only', 'b4sport:13127', '--only', 'motivato:ultramaraton-bieszczadzki-2026'],
    today: TODAY,
  })
  assert.deepEqual(scope.only, [
    { source: 'b4sport', source_id: '13127' },
    { source: 'motivato', source_id: 'ultramaraton-bieszczadzki-2026' },
  ])
})

// A named row is a deliberate choice, so neither filter that exists to bound a
// bulk run applies to it. The date floor is there to stop the step paying for
// races that already happened, and the un-mined gate is there to stop it
// paying twice; a person naming one row has answered both questions. Without
// this, re-mining a row a fix was measured against needs an UPDATE clearing
// enriched_regulamin_at, which is a database write to get a read-only rerun.
test('--only overrides the date floor and the un-mined gate', () => {
  const scope = resolveRegulaminScope({ argv: ['--only', 'b4sport:13127'], today: TODAY })
  assert.equal(scope.minDate, null)
  assert.equal(scope.unminedOnly, false)
})

test('a run with no --only still mines un-mined future rows', () => {
  const scope = resolveRegulaminScope({ argv: [], today: TODAY })
  assert.equal(scope.only, null)
  assert.equal(scope.unminedOnly, true)
})

test('--only rejects anything that is not source:source_id', () => {
  for (const bad of ['b4sport', ':13127', 'b4sport:', '']) {
    assert.throws(
      () => resolveRegulaminScope({ argv: ['--only', bad], today: TODAY }),
      /--only expects source:source_id/,
      JSON.stringify(bad)
    )
  }
  assert.throws(
    () => resolveRegulaminScope({ argv: ['--only'], today: TODAY }),
    /--only expects source:source_id/
  )
})

test('the description names the rows when --only is given', () => {
  const scope = resolveRegulaminScope({ argv: ['--only', 'b4sport:13127'], today: TODAY })
  assert.match(scope.description, /b4sport:13127/)
})
