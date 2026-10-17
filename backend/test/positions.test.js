import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankFinishers } from '../src/lib/positions.js'

const row = (id, gunDurationMs, status = 'finished') => ({ id, finishTime: gunDurationMs ? 'x' : null, gunDurationMs, status })

test('finishers are ranked by brutto time', () => {
  const p = rankFinishers([row('a', 3000), row('b', 1000), row('c', 2000)])
  assert.deepEqual([p.get('b'), p.get('c'), p.get('a')], [1, 2, 3])
})

test('DSQ, DNF and DNS never place, even with a finish time', () => {
  const p = rankFinishers([row('a', 1000, 'dsq'), row('b', 2000), row('c', 1500, 'dnf'), row('d', 900, 'dns'), row('e', 3000)])
  assert.deepEqual(Object.fromEntries(p), { a: null, b: 1, c: null, d: null, e: 2 })
})

test('a runner with no finish has no position', () => {
  const p = rankFinishers([row('a', null, 'started'), row('b', 1000)])
  assert.equal(p.get('a'), null)
  assert.equal(p.get('b'), 1)
})
