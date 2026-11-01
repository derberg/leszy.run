// Final review I-4: the SendGrid call gives up after 10 s, and the paid-order confirmation's claim
// (orders.confirmation_sent_at) is given back only when the provider certainly did not take the
// mail. A database with no rows and no network: nothing here reaches a real stack or SendGrid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SENDGRID_TIMEOUT_MS, postToSendGrid } from '../../../supabase/functions/_shared/email.js'
import { sendOrderConfirmation } from '../../../supabase/functions/_shared/registration/orderFlow.js'
import { groupRefusal } from '../../../supabase/functions/_shared/registration/registrationRequest.js'

const stalled = (_url, { signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason))
})

test('I-4 the SendGrid call carries a 10 s timeout', async () => {
  assert.equal(SENDGRID_TIMEOUT_MS, 10_000)
  let seen
  const res = await postToSendGrid({ subject: 'x' }, 'key', {
    fetchFn: async (url, init) => { seen = { url, init }; return new Response('', { status: 202 }) },
  })
  assert.equal(res.status, 202)
  assert.equal(seen.url, 'https://api.sendgrid.com/v3/mail/send')
  assert.ok(seen.init.signal instanceof AbortSignal)
  assert.equal(seen.init.headers.Authorization, 'Bearer key')
})

test('I-4 a stall is given up, never retried, and reported as „maybe delivered”', async () => {
  let calls = 0
  const err = await postToSendGrid({}, 'key', { timeoutMs: 10, fetchFn: (u, i) => { calls += 1; return stalled(u, i) } })
    .then(() => null, (e) => e)
  assert.ok(err, 'it rejects')
  assert.equal(err.deliveryUnknown, true)
  assert.equal(err.cause?.name, 'TimeoutError')
  assert.equal(calls, 1, 'a retry could send the mail twice')
})

test('I-4 any network failure is „maybe delivered” too: the provider may have read the request', async () => {
  const err = await postToSendGrid({}, 'key', { fetchFn: async () => { throw new TypeError('connection reset') } })
    .then(() => null, (e) => e)
  assert.equal(err.deliveryUnknown, true)
})

/** An admin client with one order: records every orders update and every alert. */
function fakeAdmin({ stamped = null } = {}) {
  const state = { stamped, updates: [], alerts: [] }
  const ordersUpdate = (values) => {
    const q = {
      filters: {},
      eq(k, v) { q.filters[k] = v; return q },
      is(k, v) { q.filters[`is:${k}`] = v; return q },
      select() {
        if (state.stamped !== null) return Promise.resolve({ data: [], error: null })
        state.stamped = values.confirmation_sent_at
        state.updates.push(values)
        return Promise.resolve({ data: [{ id: q.filters.id }], error: null })
      },
      then(resolve) {
        state.stamped = values.confirmation_sent_at
        state.updates.push(values)
        return resolve({ error: null })
      },
    }
    return q
  }
  return {
    state,
    from(table) {
      if (table === 'orders') return { update: ordersUpdate }
      if (table === 'operator_alerts') return { insert: async (row) => { state.alerts.push(row); return { error: null } } }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const unknown = () => Object.assign(new Error('SendGrid: no answer'), { deliveryUnknown: true })

test('I-4 a refused send gives the claim back, so registration-jobs resends it', async () => {
  const admin = fakeAdmin()
  const ok = await sendOrderConfirmation(admin, 'o1', { deliver: async () => { throw new Error('e-mail not accepted (500)') } })
  assert.equal(ok, false)
  assert.equal(admin.state.stamped, null, 'released')
  assert.deepEqual(admin.state.alerts, [])
})

test('I-4 a send that timed out keeps the claim and alerts the operator: SendGrid may have taken it, and twice is worse than a hand resend', async () => {
  const admin = fakeAdmin()
  const ok = await sendOrderConfirmation(admin, 'o1', { deliver: async () => { throw unknown() } })
  assert.equal(ok, false)
  assert.notEqual(admin.state.stamped, null, 'still claimed: the job never resends it')
  assert.deepEqual(admin.state.alerts.map((a) => [a.kind, a.order_id]), [['confirmation_email_unknown', 'o1']])
})

test('I-4 the job\'s own resend (claimed) alerts on either failure and never releases', async () => {
  for (const err of [new Error('e-mail not accepted (500)'), unknown()]) {
    const admin = fakeAdmin({ stamped: '2026-11-01T10:00:00Z' })
    assert.equal(await sendOrderConfirmation(admin, 'o1', { claimed: true, deliver: async () => { throw err } }), false)
    assert.equal(admin.state.updates.length, 0)
    assert.equal(admin.state.alerts.length, 1)
  }
})

test('I-4 a sent mail keeps the claim; a second caller finds it stamped and sends nothing', async () => {
  const admin = fakeAdmin()
  let sent = 0
  assert.equal(await sendOrderConfirmation(admin, 'o1', { deliver: async () => { sent += 1; return true } }), true)
  assert.equal(await sendOrderConfirmation(admin, 'o1', { deliver: async () => { sent += 1; return true } }), false)
  assert.equal(sent, 1)
})

test('final review I-1: a group\'s team_competition names the competition, the legacy body does not', async () => {
  const competitions = new Map([['c1', { category_id: 'c1', kind: 'individual' }], ['t1', { category_id: 't1', kind: 'team' }]])
  const people = [{ categoryId: 'c1' }, { categoryId: 't1' }]
  assert.deepEqual(await groupRefusal(null, 'team_competition', { competitions, people, legacy: false }),
    [409, { error: 'W tej konkurencji startują tylko drużyny.', code: 'team_competition', categoryId: 't1' }])
  assert.deepEqual(await groupRefusal(null, 'team_competition', { competitions, people: [people[1]], legacy: true }),
    [409, { error: 'W tej konkurencji startują tylko drużyny.', code: 'team_competition' }])
})
