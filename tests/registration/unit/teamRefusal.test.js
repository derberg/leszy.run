// Plan 5, task 5a: every refusal of create_team_registration as the captain reads it (T-46), and
// startPaymentAttempt's own branches that need no dpay (D5-24). A database with no rows: nothing
// here reaches a real stack.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamRefusal } from '../../../supabase/functions/_shared/registration/registrationRequest.js'
import { startPaymentAttempt } from '../../../supabase/functions/_shared/registration/orderFlow.js'
import { TEAM_NAME_MESSAGE, teamSizeMessage } from '../../../supabase/functions/_shared/registration/team.js'

const competition = { team_min: 3, team_max: 5 }
const refuse = (message, code = 'P0001') => teamRefusal(null, { message, code }, { competition, people: [], email: 'a@b.pl' })

test('T-46 every RPC refusal has an answer in Polish, with no raw code in the text', async () => {
  const expected = {
    team_name_taken: [409, 'Ta nazwa drużyny jest już zajęta.'],
    invalid_team_name: [400, TEAM_NAME_MESSAGE],
    team_size: [409, teamSizeMessage(3, 5)],
    not_team: [409, 'Ta konkurencja nie jest dla drużyn.'],
    invalid_people: [400, 'Popraw zaznaczone pola.'],
    no_price: [409, 'Ta konkurencja nie ma jeszcze ceny. Spróbuj później.'],
    session_required: [401, 'Wpisz kod wysłany na adres e-mail.'],
    invalid_buyer_email: [400, 'Popraw adres e-mail.'],
    too_many_pending: [409, 'Masz już dwa nieopłacone zgłoszenia na te zawody.'],
    paying_closed: [409, 'Zapisy z płatnością online kończą się godzinę przed zamknięciem zapisów.'],
    'invalid_amount:total': [400, 'Kwota zamówienia przekracza limit płatności online.'],
    full: [409, 'Brak wolnych miejsc dla drużyn.'],
    closed: [409, 'Zapisy są zamknięte.'],
    not_open: [409, 'Zapisy jeszcze się nie rozpoczęły.'],
    consents_changed: [400, 'Zaznacz wymagane zgody.'],
  }
  for (const [message, [status, text]] of Object.entries(expected)) {
    const answer = await refuse(message)
    assert.ok(answer, message)
    assert.equal(answer[0], status, message)
    assert.equal(answer[1].error, text, message)
  }
})

test('T-46 the name refusals sit under fields.teamName; session_required asks for the code; not_found → 404', async () => {
  assert.deepEqual((await refuse('team_name_taken'))[1].fields, { teamName: 'Ta nazwa drużyny jest już zajęta.' })
  assert.deepEqual((await refuse('invalid_team_name'))[1].fields, { teamName: TEAM_NAME_MESSAGE })
  assert.equal((await refuse('session_required'))[1].code, 'code_required')
  assert.deepEqual(await refuse('not_found'), [404, { error: 'Not found' }])
})

test('T-46 a deadlock (40P01) → 409 asking to try again, whatever the message says', async () => {
  const [status, body] = await refuse('deadlock detected', '40P01')
  assert.equal(status, 409)
  assert.equal(body.code, 'try_again')
  assert.match(body.error, /Spróbuj ponownie/)
})

test('T-46 price_changed:<n> carries the amounts of one fee', async () => {
  const [status, body] = await refuse('price_changed:24000')
  assert.equal(status, 409)
  assert.equal(body.code, 'price_changed')
  assert.deepEqual(body.amounts, { entryPrices: [24000], entryTotal: 24000, extrasTotal: 0, donation: 0, total: 24000 })
})

test('T-46 an unknown error is no refusal: it stays a 500', async () => {
  assert.equal(await refuse('something else'), null)
})

function fakeAdmin({ cancelError = null } = {}) {
  const calls = []
  return {
    calls,
    rpc: async (fn, args) => { calls.push([fn, args]); return { data: null, error: cancelError } },
    from: (table) => ({ insert: async (row) => { calls.push([table, row]); return { error: null } } }),
  }
}

test('D5-24 no dpay settings: refused; cancelled only with cancelOnFailure, with its reason; a failed cancel raises the alert', async () => {
  const kept = fakeAdmin()
  assert.deepEqual(await startPaymentAttempt(kept, null, { orderId: 'o1', total: 100 }), { refused: 'dpay_unconfigured' })
  assert.deepEqual(kept.calls, [])

  const cancelled = fakeAdmin()
  assert.deepEqual(await startPaymentAttempt(cancelled, null, { orderId: 'o1', total: 100, cancelOnFailure: true }), { refused: 'dpay_unconfigured' })
  assert.deepEqual(cancelled.calls, [['cancel_order', { p_order_id: 'o1', p_reason: 'dpay_unconfigured' }]])

  const stuck = fakeAdmin({ cancelError: { message: 'boom' } })
  assert.deepEqual(await startPaymentAttempt(stuck, null, { orderId: 'o1', total: 100, cancelOnFailure: true }), { refused: 'dpay_unconfigured' })
  const alert = stuck.calls.find(([t]) => t === 'operator_alerts')
  assert.equal(alert[1].kind, 'cancel_failed')
  assert.equal(alert[1].order_id, 'o1')
})
