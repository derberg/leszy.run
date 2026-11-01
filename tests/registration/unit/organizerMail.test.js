// Plan 6 Task 4 fix round 1: an organizer e-mail never turns into a 500, and a send that did not
// go out gives its allowance back (M1, the 10 s SendGrid timeout); the CSV audit never keeps the
// search text (I1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendOnAllowance, trySend } from '../../../supabase/functions/_shared/registration/organizerMail.js'
import { filterSummary } from '../../../supabase/functions/_shared/registration/entriesFilter.js'

const timeout = () => {
  const err = new Error('SendGrid: no answer in 10000 ms')
  err.deliveryUnknown = true
  return err
}

test('trySend: an accepted send is ok, a refused one is not, a throw never escapes', async () => {
  assert.deepEqual(await trySend(async () => ({ ok: true, status: 202 })), { ok: true })
  assert.deepEqual(await trySend(async () => ({ ok: false, status: 500 })), { ok: false, unknown: false, status: 500 })
  const lost = await trySend(async () => { throw timeout() })
  assert.equal(lost.ok, false)
  assert.equal(lost.unknown, true, 'a timeout may have been delivered')
  const broken = await trySend(async () => { throw new Error('boom') })
  assert.equal(broken.ok, false)
  assert.equal(broken.unknown, false)
})

/** A one-slot allowance and a sender: what was claimed, given back and sent. */
function harness(send) {
  const log = { claims: 0, releases: 0, sends: 0, used: 0 }
  return {
    log,
    claim: async () => {
      log.claims++
      if (log.used >= 1) return { allowed: false, retryAfterSec: 99 }
      log.used++
      return { allowed: true }
    },
    release: async () => { log.releases++; log.used-- },
    send: async () => { log.sends++; return send() },
  }
}

test('sendOnAllowance: a sent e-mail keeps its slot, the next call is throttled', async () => {
  const h = harness(async () => ({ ok: true }))
  assert.deepEqual(await sendOnAllowance(h), { sent: true })
  assert.deepEqual(await sendOnAllowance(h), { throttled: 99 })
  assert.deepEqual(h.log, { claims: 2, releases: 0, sends: 1, used: 1 })
})

test('sendOnAllowance: a refused send gives the slot back, so the organizer can try again at once', async () => {
  let answer = { ok: false, status: 500 }
  const h = harness(async () => answer)
  assert.deepEqual(await sendOnAllowance(h), { failed: true, unknown: false })
  answer = { ok: true }
  assert.deepEqual(await sendOnAllowance(h), { sent: true })
})

test('sendOnAllowance: a timeout (deliveryUnknown) never throws and gives the slot back', async () => {
  const h = harness(async () => { throw timeout() })
  assert.deepEqual(await sendOnAllowance(h), { failed: true, unknown: true })
  assert.equal(h.log.releases, 1)
})

test('sendOnAllowance: a release that fails is logged, never thrown', async () => {
  const h = harness(async () => ({ ok: false, status: 0 }))
  h.release = async () => { throw new Error('db down') }
  assert.deepEqual(await sendOnAllowance(h), { failed: true, unknown: false })
})

test('filterSummary: the filter keys used and whether there was a search, never the search text', () => {
  assert.deepEqual(filterSummary({}), { keys: [], search: false })
  assert.deepEqual(filterSummary(null), { keys: [], search: false })
  const s = filterSummary({ categoryId: 'c1', statusKey: 'paid', q: 'anna@example.pl', partnerId: '', other: 'x' })
  assert.deepEqual(s, { keys: ['categoryId', 'statusKey'], search: true })
  assert.ok(!JSON.stringify(s).includes('anna'))
  assert.deepEqual(filterSummary({ q: '   ' }), { keys: [], search: false })
})
