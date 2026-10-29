import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startListView } from '../../src/lib/startList.js'

const SNAP = {
  version: 'v1',
  competitions: [
    { categoryId: 'c1', name: 'Bieg 9 km', capacity: 80, paid: 32, awaiting: 2 },
    { categoryId: 'c2', name: 'Bieg 3 km', capacity: 40, paid: 21, awaiting: 0 },
  ],
  entries: [
    { name: 'Tomasz Kowal', town: 'Gliwice', club: null, categoryId: 'c1', competition: 'Bieg 9 km', ageGroupLabel: 'M30–39', paid: false },
    { name: 'Agnieszka Mazur', town: 'Zabrze', club: 'ZATYRANI', categoryId: 'c1', competition: 'Bieg 9 km', ageGroupLabel: 'K40–49', paid: true },
    { name: 'Paweł Zieliński', town: null, club: 'KB Sośnica', categoryId: 'c2', competition: 'Bieg 3 km', ageGroupLabel: null, paid: true },
  ],
}

describe('startListView (RA8 columns)', () => {
  it('per competition: taken of capacity, the paid and awaiting bars, the counts', () => {
    const v = startListView(SNAP)
    assert.deepEqual(v.competitions[0], {
      categoryId: 'c1', name: 'Bieg 9 km', taken: 34, capacity: 80, paidPct: 40, awaitingPct: 2.5,
      paidLabel: '32 opłaconych', awaitingLabel: '2 czeka na wpłatę',
    })
    assert.equal(v.competitions[1].awaitingLabel, null)
  })

  it('the header: „X opłaconych · Y czeka na wpłatę” over the whole event', () => {
    assert.equal(startListView(SNAP).header, '53 opłaconych · 2 czeka na wpłatę')
    assert.equal(startListView({ competitions: [], entries: [] }).header, '0 opłaconych · 0 czeka na wpłatę')
  })

  it('each entry: name, town · club, competition · category, the payment badge', () => {
    const [a, b, c] = startListView(SNAP).entries
    assert.deepEqual(a, { name: 'Tomasz Kowal', where: 'Gliwice', what: 'Bieg 9 km · M30–39', paid: false, badge: 'czeka na wpłatę' })
    assert.equal(b.where, 'Zabrze · ZATYRANI')
    assert.equal(b.badge, 'opłacone')
    assert.equal(c.where, 'KB Sośnica')
    assert.equal(c.what, 'Bieg 3 km')
  })

  it('a bar never goes past 100 percent', () => {
    const v = startListView({ competitions: [{ categoryId: 'x', name: 'X', capacity: 10, paid: 12, awaiting: 1 }], entries: [] })
    assert.ok(v.competitions[0].paidPct + v.competitions[0].awaitingPct <= 100)
  })
})
