import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/store.js'

test('save/load/remove roundtrip; load of missing returns null', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpagent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new FileStore(dir)
  assert.equal(await store.load('session'), null)
  await store.save('session', { eventId: 'e1', checkpointId: 'c1' })
  assert.deepEqual(await store.load('session'), { eventId: 'e1', checkpointId: 'c1' })
  await store.remove('session')
  assert.equal(await store.load('session'), null)
})
