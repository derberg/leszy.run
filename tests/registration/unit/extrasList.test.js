import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extrasList, extrasText, handoutUnits } from '../../../supabase/functions/_shared/registration/extrasList.js'
import { extrasToCsv } from '../../../supabase/functions/_shared/registration/entriesCsv.js'

const line = (over = {}) => ({
  lineId: 'l', extraId: 'e1', name: 'Koszulka', variantId: 'vL', variant: 'L', qty: 1, amount: 5000, refunded: 0, ...over,
})
const row = (over = {}) => ({
  id: 'r', status: 'confirmed', statusKey: 'paid', withdrawn: false, bib: null, firstName: 'Anna', lastName: 'Nowak',
  name: 'Anna Nowak', competition: 'Bieg 9 km', team: null, email: 'anna@example.pl', guardianEmail: null,
  phone: '500600700', role: 'self', extras: [line()], ...over,
})
const cellsOf = (l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1])

describe('extrasList', () => {
  it('counts units and builds totals per variant', () => {
    const rows = [
      row({ extras: [line({ variantId: 'vS', variant: 'S' }), line({ variantId: 'vL', variant: 'L' })] }),
      row({ extras: [line({ qty: 2, amount: 10000 })] }),
    ]
    const { totals } = extrasList(rows)
    assert.deepEqual(totals.map((t) => [t.extra, t.variant, t.count]), [['Koszulka', 'S', 1], ['Koszulka', 'L', 3]])
  })
  it('totals follow the event order, not first appearance', () => {
    const o = (extraOrder, variantOrder) => ({ extraOrder, variantOrder })
    const a = row({ extras: [line({ ...o(0, 1) })] })
    const b = row({ extras: [line({ variantId: 'vS', variant: 'S', ...o(0, 0) }), line({ ...o(0, 1) })] })
    assert.deepEqual(extrasList([a, b]).totals.map((t) => [t.variant, t.count]), [['S', 1], ['L', 2]])
    const medal = row({ extras: [line({ extraId: 'e2', name: 'Medal', variantId: null, variant: null, amount: 0, ...o(1, 0) })] })
    assert.deepEqual(extrasList([medal, a]).totals.map((t) => t.extra), ['Koszulka', 'Medal'])
  })
  it('a line with no quantity gives no units', () => {
    assert.equal(handoutUnits({ qty: 0, amount: 0, refunded: 0 }), 0)
    assert.deepEqual(extrasList([row({ extras: [line({ qty: 0, amount: 0 })] })]).handout, [])
  })
  it('partial refund of one unit leaves two', () => {
    const { handout, totals } = extrasList([row({ extras: [line({ qty: 3, amount: 15000, refunded: 5000 })] })])
    assert.equal(handout[0].qty, 2)
    assert.equal(totals[0].count, 2)
  })
  it('a partial refund shows units and the kept money', () => {
    const { handout } = extrasList([row({ extras: [line({ qty: 2, amount: 10000, refunded: 5000 })] })])
    assert.equal(handout[0].qty, 1)
    assert.equal(handout[0].paid, 5000)
  })
  it('a withdrawn awaiting entry is left out of awaiting too', () => {
    const l = extrasList([row({ status: 'pending_payment', statusKey: 'awaiting', withdrawn: true })])
    assert.deepEqual(l.awaiting, [])
  })
  it('a fully refunded line and a 0 zł line', () => {
    const { handout } = extrasList([row({ extras: [line({ lineId: 'a', amount: 5000, refunded: 5000 }), line({ lineId: 'b', name: 'Medal', extraId: 'e2', amount: 0 })] })])
    assert.deepEqual(handout.map((i) => i.extra), ['Medal'])
  })
  it('withdrawn and removed entries are left out', () => {
    const l = extrasList([row({ withdrawn: true }), row({ status: 'cancelled', statusKey: 'cancelled' }), row({ status: 'transferred_out', statusKey: 'transferred' })])
    assert.deepEqual(l, { handout: [], awaiting: [], totals: [] })
  })
  it('unpaid goes to awaiting, expired and cancelled nowhere', () => {
    const l = extrasList([
      row({ id: 'a', status: 'pending_payment', statusKey: 'awaiting', extras: [line({ qty: 2, amount: 10000 })] }),
      row({ id: 'b', status: 'pending_payment', statusKey: 'expired' }),
      row({ id: 'c', status: 'expired', statusKey: 'expired' }),
    ])
    assert.equal(l.handout.length, 0)
    assert.equal(l.awaiting.length, 1)
    assert.equal(l.awaiting[0].qty, 2)
    assert.equal(l.awaiting[0].paid, null)
    assert.deepEqual(l.totals, [])
  })
  it('extraId narrows the lines', () => {
    const r = row({ extras: [line(), line({ lineId: 'm', extraId: 'e2', name: 'Medal', variantId: null, variant: null, amount: 0 })] })
    const l = extrasList([r], { extraId: 'e2' })
    assert.deepEqual(l.handout.map((i) => i.extra), ['Medal'])
    assert.deepEqual(l.totals.map((t) => t.extra), ['Medal'])
  })
  it('a child shows the guardian e-mail and own phone', () => {
    const { handout } = extrasList([row({ role: 'minor', email: null, guardianEmail: 'rodzic@example.pl', phone: '600' })], { contacts: true })
    assert.equal(handout[0].email, 'rodzic@example.pl')
    assert.equal(handout[0].phone, '600')
  })
  it('sorted by bib, no bib last, then surname in Polish order', () => {
    const { handout } = extrasList([
      row({ id: '1', bib: null, lastName: 'Adamski' }),
      row({ id: '2', bib: 9, lastName: 'Zet' }),
      row({ id: '3', bib: 2, lastName: 'Łoś' }),
      row({ id: '4', bib: null, lastName: 'Żak' }),
      row({ id: '5', bib: null, lastName: 'Zawada' }),
    ])
    assert.deepEqual(handout.map((i) => i.lastName), ['Łoś', 'Zet', 'Adamski', 'Zawada', 'Żak'])
  })
  it('empty input gives empty lists', () => {
    assert.deepEqual(extrasList([]), { handout: [], awaiting: [], totals: [] })
  })
})

describe('extrasText', () => {
  it('names variant and quantity', () => {
    assert.equal(extrasText([
      { name: 'Koszulka', variant: 'L', qty: 2, amount: 10000, refunded: 0 },
      { name: 'Medal', variant: 'Złoty', qty: 1, amount: 0, refunded: 0 },
    ]), 'Koszulka L ×2, Medal Złoty')
  })
  it('suffixes a fully refunded line, and copes with no variant', () => {
    assert.equal(extrasText([{ name: 'Medal', variant: null, qty: 1, amount: 500, refunded: 500 }]), 'Medal (zwrócono)')
    assert.equal(extrasText([]), '')
  })
  it('a partly refunded line shows the units still to hand out', () => {
    assert.equal(extrasText([{ name: 'Koszulka', variant: 'L', qty: 2, amount: 10000, refunded: 5000 }]), 'Koszulka L ×1 (zwrócono 1)')
    assert.equal(extrasText([{ name: 'Koszulka', variant: 'L', qty: 2, amount: 10000, refunded: 10000 }]), 'Koszulka L ×2 (zwrócono)')
  })
})

describe('hardening', () => {
  it('refunded units use integer math (1000 over 3 units)', () => {
    assert.equal(handoutUnits({ qty: 3, amount: 1000, refunded: 333 }), 3)
    assert.equal(handoutUnits({ qty: 3, amount: 1000, refunded: 334 }), 2)
  })
  it('awaiting items carry no paid amount', () => {
    const l = extrasList([row({ status: 'pending_payment', statusKey: 'awaiting', extras: [line()] })])
    assert.equal(l.awaiting[0].paid, null)
  })
  it('contacts only on request', () => {
    const r = row({ email: 'a@b.pl', phone: '+48123', extras: [line()] })
    const plain = extrasList([r]).handout[0]
    assert.equal('email' in plain, false)
    assert.equal('phone' in plain, false)
    const withContacts = extrasList([r], { contacts: true }).handout[0]
    assert.equal(withContacts.email, 'a@b.pl')
    assert.equal(withContacts.phone, '+48123')
  })
  it('a row with no withdrawn flag is handed out like awaiting', () => {
    const r = row({ extras: [line()] })
    delete r.withdrawn
    assert.equal(extrasList([r]).handout.length, 1)
  })
  it('totals with an order rank before totals without', () => {
    const l = extrasList([
      row({ id: 'a', extras: [line({ extraId: 'x', variantId: 'x1', name: 'X' })] }),
      row({ id: 'b', extras: [line({ extraId: 'y', variantId: 'y1', name: 'Y', extraOrder: 1, variantOrder: 0 })] }),
      row({ id: 'c', extras: [line({ extraId: 'z', variantId: 'z1', name: 'Z', extraOrder: 0, variantOrder: 0 })] }),
    ])
    assert.deepEqual(l.totals.map((t) => t.extra), ['Z', 'Y', 'X'])
  })
})

describe('extrasToCsv', () => {
  const list = extrasList([
    row({ bib: 5, extras: [line({ qty: 2, amount: 10000 })] }),
    row({ id: 'p', status: 'pending_payment', statusKey: 'awaiting', lastName: 'Zet', extras: [line()] }),
  ], { contacts: true })
  it('layout', () => {
    const csv = extrasToCsv(list)
    assert.ok(csv.startsWith('﻿'))
    const lines = csv.slice(1).split('\r\n')
    assert.deepEqual(cellsOf(lines[0]), ['Nr', 'Imię', 'Nazwisko', 'Konkurencja', 'Drużyna', 'Dodatek', 'Wariant', 'Ilość', 'Wpłata (zł)', 'E-mail', 'Telefon', 'Status'])
    assert.deepEqual(cellsOf(lines[1]), ['5', 'Anna', 'Nowak', 'Bieg 9 km', '', 'Koszulka', 'L', '2', '100,00', 'anna@example.pl', '500600700', 'do wydania'])
    assert.equal(cellsOf(lines[2]).at(-1), 'czeka na wpłatę')
    assert.equal(lines[3], '')
    assert.deepEqual(cellsOf(lines[4]), ['Dodatek', 'Wariant', 'Do wydania'])
    assert.deepEqual(cellsOf(lines[5]), ['Koszulka', 'L', '2'])
  })
  it('awaiting rows have an empty Wpłata', () => {
    const lines = extrasToCsv(list).slice(1).split('\r\n')
    assert.equal(cellsOf(lines[1])[8], '100,00')
    assert.equal(cellsOf(lines[2])[8], '')
  })
  it('a deleted account shows its name in Imię and nothing in Nazwisko', () => {
    const l = extrasList([row({ firstName: null, lastName: null, name: 'Usunięte konto' })])
    const cells = cellsOf(extrasToCsv(l).slice(1).split('\r\n')[1])
    assert.deepEqual(cells.slice(1, 3), ['Usunięte konto', ''])
  })
  it('defuses formulas', () => {
    const l = extrasList([row({ extras: [line({ name: '=HYPERLINK()' })] })])
    assert.ok(extrasToCsv(l).includes('"\'=HYPERLINK()"'))
  })
})
