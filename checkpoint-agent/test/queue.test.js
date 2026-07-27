import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObservationQueue } from '../src/queue.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cpq-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const row = (n) => ({ epc: `EPC${n}`, checkpoint_id: 'cp-1', bib_number: n, observed_at: new Date(n * 1000).toISOString() })

test('append + pending + advance', async (t) => {
  const q = new ObservationQueue(await tempDir(t))
  await q.init()
  await q.append(row(1)); await q.append(row(2))
  assert.equal(q.pending().length, 2)
  await q.advance(1)
  assert.equal(q.pending().length, 1)
  assert.equal(q.pending()[0].bib_number, 2)
  assert.deepEqual(q.counts, { total: 2, pending: 1 })
})

test('survives restart: rows and cursor reload from disk', async (t) => {
  const dir = await tempDir(t)
  const q1 = new ObservationQueue(dir)
  await q1.init()
  await q1.append(row(1)); await q1.append(row(2)); await q1.append(row(3))
  await q1.advance(2)
  const q2 = new ObservationQueue(dir)
  await q2.init()
  assert.equal(q2.pending().length, 1)
  assert.equal(q2.pending()[0].bib_number, 3)
  assert.deepEqual(q2.epcs(), ['EPC1', 'EPC2', 'EPC3'])
})

test('tolerates a torn last line (power loss mid-append)', async (t) => {
  const dir = await tempDir(t)
  const q1 = new ObservationQueue(dir)
  await q1.init()
  await q1.append(row(1))
  const { appendFile } = await import('node:fs/promises')
  await appendFile(join(dir, 'queue.jsonl'), '{"epc":"EPC2","bib_nu') // torn write
  const q2 = new ObservationQueue(dir)
  await q2.init()
  assert.equal(q2.counts.total, 1) // torn line dropped
})

test('cleans up torn line from disk on next init', async (t) => {
  const dir = await tempDir(t)
  const q1 = new ObservationQueue(dir)
  await q1.init()
  await q1.append(row(1))
  const { appendFile } = await import('node:fs/promises')
  await appendFile(join(dir, 'queue.jsonl'), '{"epc":"EPC2","bib_nu') // torn write
  const q2 = new ObservationQueue(dir)
  await q2.init()
  assert.equal(q2.counts.total, 1)
  await q2.append(row(3))
  // Now restart and verify the file is clean (no corruption propagation)
  const q3 = new ObservationQueue(dir)
  await q3.init()
  assert.deepEqual(q3.epcs(), ['EPC1', 'EPC3'])
})
