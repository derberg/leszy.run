// Run: node --test frontend/src/lib/volunteerFinish.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { volunteerFinishAt, volunteerFinishCheck } from './volunteerFinish.js'

const at = (hms) => `2026-08-07T${hms}.000Z`

test('the 2026-08-07 bib 27 case is flagged: chip 15.5 min after the volunteer', () => {
  const check = volunteerFinishCheck(at('19:29:28'), at('19:13:58'))
  assert.equal(check.kind, 'mismatch')
  assert.equal(check.diffMs, 930_000)
})

test('the normal volunteer lag behind the chip is not flagged', () => {
  assert.equal(volunteerFinishCheck(at('19:09:14'), at('19:09:25')), null) // +11 s
  assert.equal(volunteerFinishCheck(at('19:32:35'), at('19:33:01')), null) // +26 s
})

test('a chip finish well before the volunteer entry is flagged too', () => {
  assert.equal(volunteerFinishCheck(at('19:00:00'), at('19:02:00')).kind, 'mismatch')
})

test('a volunteer entry with no finish on the result is flagged as missing', () => {
  assert.deepEqual(volunteerFinishCheck(null, at('19:17:35')), { kind: 'no-finish', volunteerAt: at('19:17:35'), diffMs: null })
})

test('no volunteer entry, nothing to flag', () => {
  assert.equal(volunteerFinishCheck(at('19:00:00'), null), null)
  assert.equal(volunteerFinishCheck(null, null), null)
})

test('only checkpoints marked as the manual finish count', () => {
  const cps = [{ id: 'cp5km' }, { id: 'meta', isFinish: true }]
  const obs = { cp5km: at('18:45:00'), meta: at('19:13:58') }
  assert.equal(volunteerFinishAt(cps, (id) => obs[id]), at('19:13:58'))
  assert.equal(volunteerFinishAt([{ id: 'cp5km' }], (id) => obs[id]), null)
})
