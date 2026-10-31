// G-70. Legal decision of 2026-10-31: nothing is payable to LESZY.RUN by a runner. A runner pays
// the organizer's price and nothing else, and LESZY.RUN invoices the organizer afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { orderAmounts } from '../../../supabase/functions/_shared/registration/money.js'
import { orderConfirmationEmail } from '../../../supabase/functions/_shared/registration/emails.js'
import { checkoutModel } from '../../../public/src/lib/checkout.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const RUNNER_FACING = [
  'public/src/pages/zapisy',
  'public/src/components/registration',
  'public/src/lib/checkout.js',
  'public/src/lib/eventPageModel.js',
  'public/src/legal/runnerDataInfo.js',
  'supabase/functions/_shared/registration/emails.js',
  'supabase/functions/create-order/index.js',
]
const FORBIDDEN = /Wspieram|Nie tym razem|Wesprzesz|Obsługa płatności|Wsparcie LESZY|wspierasz LESZY|doliczamy/

function filesUnder(path) {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)))
}

test('G-70 no runner-facing page, e-mail or refusal words a charge payable to LESZY.RUN', () => {
  const hits = RUNNER_FACING.flatMap((p) => filesUnder(join(ROOT, p)))
    .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
  assert.deepEqual(hits, [])
})

test('G-70 the total is the sum of the entry prices, for one person, a family and a free entry', () => {
  for (const entryPrices of [[6000], [6000, 4000, 2000], [0], [0, 3333], [1], [99_999_998, 1]]) {
    const sum = entryPrices.reduce((a, b) => a + b, 0)
    assert.deepEqual(orderAmounts({ entryPrices }), { entryTotal: sum, extrasTotal: 0, donation: 0, total: sum })
    const m = checkoutModel({ entryPrices })
    assert.equal(m.displayedTotal, sum)
    assert.equal(m.payDisabled, false)
  }
})

test('G-70 extras and a donation are the only things added to the entries', () => {
  assert.equal(orderAmounts({ entryPrices: [6000, 2000], extrasTotal: 500, donation: 2000 }).total, 10500)
})

test('G-70 a stale client sending supportChoice changes nothing', () => {
  const a = orderAmounts({ entryPrices: [6000] })
  assert.deepEqual(orderAmounts({ entryPrices: [6000], supportChoice: true }), a)
  assert.deepEqual(orderAmounts({ entryPrices: [6000], supportChoice: null }), a)
})

test('G-70 the payment e-mail has the entry fees and the total, and no other amount', () => {
  const mail = orderConfirmationEmail({
    event: { name: 'Bieg', slug: 'bieg', eventDate: '2027-05-01', place: 'Las' },
    order: { id: 'o1', entryTotal: 8000, total: 8000, paidTransactionId: 't1', paidAt: '2027-01-01T10:00:00Z' },
    lines: [],
    organizer: { name: 'Klub' },
    orderUrl: null,
  })
  assert.deepEqual(mail.text.match(/\d+,\d\d zł/g), ['80,00 zł', '80,00 zł']) // the entries, then „Razem”
})
