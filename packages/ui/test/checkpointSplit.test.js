import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkpointSplitMs } from '../src/lib/checkpointSplit.js'

test('split is measured from the gun', () => {
  assert.equal(checkpointSplitMs('2026-08-07T18:45:37Z', '2026-08-07T18:20:00Z'), 25 * 60_000 + 37_000)
})

test('missing gun or observation yields no split', () => {
  assert.equal(checkpointSplitMs(null, '2026-08-07T18:20:00Z'), null)
  assert.equal(checkpointSplitMs('2026-08-07T18:45:37Z', null), null)
})

test('an observation before the gun is not a split', () => {
  assert.equal(checkpointSplitMs('2026-08-07T18:19:00Z', '2026-08-07T18:20:00Z'), null)
})
