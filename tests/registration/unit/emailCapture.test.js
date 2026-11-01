// Plan 5, task 9: postToCapture, the test stack's way out for e-mail. A connection from the
// edge-runtime container to the host can stall for up to 68 s before the request is sent, which
// held dpay-ipn past the mock's 10 s timeout (P-35, P-35b, P-31, G-29). See tests/registration/README.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postToCapture } from '../../../supabase/functions/_shared/email.js'

const stalled = (_url, { signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason))
})
const options = { method: 'POST', body: '{}' }

test('a stalled connection is given up and the message goes on a new one', async () => {
  const calls = []
  const res = await postToCapture('http://capture/send', options, {
    timeoutMs: 10,
    fetchFn: (url, init) => {
      calls.push(url)
      return calls.length < 3 ? stalled(url, init) : Promise.resolve(new Response('{}', { status: 200 }))
    },
  })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 3)
})

test('an answer is never retried, whatever its status, so a bounce stays a bounce', async () => {
  let calls = 0
  const res = await postToCapture('http://capture/send', options, {
    timeoutMs: 10,
    fetchFn: async () => { calls += 1; return new Response('{}', { status: 500 }) },
  })
  assert.equal(res.status, 500)
  assert.equal(calls, 1)
})

test('a refused connection fails at once: only a stall is retried', async () => {
  let calls = 0
  await assert.rejects(postToCapture('http://capture/send', options, {
    timeoutMs: 10,
    fetchFn: async () => { calls += 1; throw new TypeError('connection refused') },
  }), TypeError)
  assert.equal(calls, 1)
})

test('it gives up after four stalls', async () => {
  let calls = 0
  await assert.rejects(postToCapture('http://capture/send', options, {
    timeoutMs: 5,
    fetchFn: (url, init) => { calls += 1; return stalled(url, init) },
  }), { name: 'TimeoutError' })
  assert.equal(calls, 4)
})
