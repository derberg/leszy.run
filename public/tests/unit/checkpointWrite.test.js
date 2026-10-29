import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkpointWrite, pinCheckOutcome, readPin, savePin, clearPin } from '../../src/lib/checkpointWrite.js'
import { classifyInsertResult } from '../../src/lib/checkpointOutbox.js'

function reply(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
}

function memoryStorage() {
  const data = {}
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
  }
}

const observe = (fetchImpl) => checkpointWrite('/edge', { action: 'observe' }, { fetchImpl })

describe('checkpointWrite → classifyInsertResult', () => {
  it('a returned row is saved', async () => {
    assert.equal(classifyInsertResult(await observe(reply(200, { data: [{ id: 'x' }] }))), 'saved')
  })

  it('no row back means the priority trigger dropped it: duplicate', async () => {
    assert.equal(classifyInsertResult(await observe(reply(200, { data: [] }))), 'duplicate')
  })

  it('23505 is a duplicate, not a failure', async () => {
    assert.equal(classifyInsertResult(await observe(reply(409, { error: 'Already recorded', code: '23505' }))), 'duplicate')
  })

  it('a wrong PIN fails the entry for good', async () => {
    const res = await observe(reply(401, { error: 'Invalid PIN', code: 'invalid_pin' }))
    assert.throws(() => classifyInsertResult(res), (err) => err.permanent === true)
  })

  it('a lockout, a server error and no connection are all retried', async () => {
    for (const fetchImpl of [
      reply(429, { error: 'Too many attempts', code: '' }),
      reply(500, { error: 'Insert failed', code: '' }),
      async () => { throw new TypeError('Failed to fetch') },
    ]) {
      const res = await observe(fetchImpl)
      assert.throws(() => classifyInsertResult(res), (err) => err.permanent === false)
    }
  })
})

describe('pinCheckOutcome', () => {
  it('maps the verify answer', async () => {
    const verify = (f) => checkpointWrite('/edge', { action: 'verify' }, { fetchImpl: f })
    assert.equal(pinCheckOutcome(await verify(reply(200, { data: { ok: true } }))), 'ok')
    assert.equal(pinCheckOutcome(await verify(reply(401, { error: 'Invalid PIN' }))), 'invalid')
    assert.equal(pinCheckOutcome(await verify(reply(429, { error: 'Too many attempts' }))), 'locked')
    assert.equal(pinCheckOutcome(await verify(async () => { throw new Error('offline') })), 'unknown')
  })
})

describe('stored PIN', () => {
  it('is kept per checkpoint and can be cleared', () => {
    const s = memoryStorage()
    savePin('cp-1', '123456', s)
    assert.equal(readPin('cp-1', s), '123456')
    assert.equal(readPin('cp-2', s), null)
    clearPin('cp-1', s)
    assert.equal(readPin('cp-1', s), null)
  })

  it('a storage that throws reads as no PIN', () => {
    const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
    assert.equal(readPin('cp-1', broken), null)
    savePin('cp-1', '1', broken)
    clearPin('cp-1', broken)
  })
})
