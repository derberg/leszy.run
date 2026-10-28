// The change notice goes out in batches of at most 1000; a failed batch is not sent (W-24).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendInBatches, BATCH_SIZE } from '../../../supabase/functions/_shared/emailBatch.js'

const people = (n) => Array.from({ length: n }, (_, i) => `r${i}@test.local`)

test('1500 recipients → two requests of 1000 and 500, all counted as sent', async () => {
  const sizes = []
  const r = await sendInBatches(people(1500), async (batch) => { sizes.push(batch.length); return { ok: true } })
  assert.equal(BATCH_SIZE, 1000)
  assert.deepEqual(sizes, [1000, 500])
  assert.deepEqual(r, { sent: 1500, failed: 0, batches: 2 })
})

test('a batch answered non-OK or throwing counts as not sent; the others still go', async () => {
  let n = 0
  const r = await sendInBatches(people(2500), async () => {
    n++
    if (n === 1) return { ok: false, status: 500 }
    if (n === 2) throw new Error('network')
    return { ok: true }
  })
  assert.deepEqual(r, { sent: 500, failed: 2000, batches: 3 })
})

test('no recipients → no request', async () => {
  const r = await sendInBatches([], async () => assert.fail('no request expected'))
  assert.deepEqual(r, { sent: 0, failed: 0, batches: 0 })
})
