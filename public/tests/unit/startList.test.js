import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startListView } from '../../src/lib/startList.js'

// The snapshot start_list() returns. Entries awaiting payment are never in it
// (ruling P3-R14): only the per-competition `awaiting` count.
const SNAP = {
  version: 'v1',
  competitions: [
    { categoryId: 'c1', name: 'Bieg 9 km', capacity: 80, paid: 32, free: 0, awaiting: 2 },
    { categoryId: 'c2', name: 'Bieg 3 km', capacity: 40, paid: 21, free: 0, awaiting: 0 },
    { categoryId: 'c3', name: 'Dzieci 1 km', capacity: 20, paid: 0, free: 5, awaiting: 0 },
  ],
  entries: [
    { name: 'Agnieszka Mazur', town: 'Zabrze', club: 'ZATYRANI', categoryId: 'c1', competition: 'Bieg 9 km', ageGroupLabel: 'K40–49', payment: 'paid' },
    { name: 'Paweł Zieliński', town: null, club: 'KB Sośnica', categoryId: 'c2', competition: 'Bieg 3 km', ageGroupLabel: null, payment: 'paid' },
    { name: 'Zosia Mała', town: null, club: null, categoryId: 'c3', competition: 'Dzieci 1 km', ageGroupLabel: 'Dzieci I', payment: 'free' },
  ],
}

const FREE_EVENT = {
  competitions: [{ categoryId: 'f1', name: 'Bieg 5 km', capacity: 50, paid: 0, free: 3, awaiting: 0 }],
  entries: [{ name: 'Ola Leśna', town: 'Gliwice', club: null, categoryId: 'f1', competition: 'Bieg 5 km', ageGroupLabel: 'K open', payment: 'free' }],
}

describe('startListView (RA8 columns, ruling P3-R14)', () => {
  it('per competition: taken of capacity, the bars, „+N czeka na wpłatę” as a count only', () => {
    const v = startListView(SNAP, { paidEvent: true })
    assert.deepEqual(v.competitions[0], {
      categoryId: 'c1', name: 'Bieg 9 km', taken: 34, capacity: 80, paidPct: 40, freePct: 0, awaitingPct: 2.5,
      paidLabel: '32 opłacone', freeLabel: null, awaitingLabel: '+2 czekają na wpłatę',
    })
    assert.equal(v.competitions[1].awaitingLabel, null)
  })

  it('a 0 zł competition of a paid event is never „opłacone”: its runners are counted as free', () => {
    const c = startListView(SNAP, { paidEvent: true }).competitions[2]
    assert.equal(c.paidLabel, null)
    assert.equal(c.freeLabel, '5 bez opłaty')
    assert.equal(c.paidPct, 0)
    assert.equal(c.freePct, 25)
  })

  it('the header of a paid event: opłacone, the free ones and the awaiting count', () => {
    assert.equal(startListView(SNAP, { paidEvent: true }).header, '53 opłacone · 5 bez opłaty · +2 czekają na wpłatę')
    assert.equal(startListView({ competitions: [], entries: [] }, { paidEvent: true }).header, '0 opłaconych')
  })

  it('counts take their Polish form (M5): 1 opłacone / +1 czeka, 5 opłaconych / +5 czeka, 12 opłaconych', () => {
    const snap = (paid, awaiting) => ({ competitions: [{ categoryId: 'c', name: 'B', capacity: 50, paid, free: 0, awaiting }], entries: [] })
    assert.equal(startListView(snap(1, 1), { paidEvent: true }).header, '1 opłacone · +1 czeka na wpłatę')
    assert.equal(startListView(snap(5, 5), { paidEvent: true }).header, '5 opłaconych · +5 czeka na wpłatę')
    assert.equal(startListView(snap(12, 3), { paidEvent: true }).header, '12 opłaconych · +3 czekają na wpłatę')
    assert.equal(startListView(snap(1, 1), { paidEvent: true }).competitions[0].paidLabel, '1 opłacone')
    const free = (n) => ({ competitions: [{ categoryId: 'f', name: 'B', capacity: 50, paid: 0, free: n, awaiting: 0 }], entries: [] })
    assert.equal(startListView(free(1), { paidEvent: false }).header, '1 osoba zapisana')
    assert.equal(startListView(free(5), { paidEvent: false }).header, '5 osób zapisanych')
  })

  it('a free event: „N osoby zapisane”, no badge, nothing about payment anywhere', () => {
    const v = startListView(FREE_EVENT, { paidEvent: false })
    assert.equal(v.header, '3 osoby zapisane')
    assert.equal(v.entries[0].badge, null)
    assert.equal(v.competitions[0].paidLabel, null)
    assert.equal(v.competitions[0].freeLabel, null)
    assert.ok(!JSON.stringify(v).includes('opłac'))
  })

  it('each entry: name, town · club, competition · category; „opłacone” only for a paid entry', () => {
    const [a, b, c] = startListView(SNAP, { paidEvent: true }).entries
    assert.deepEqual(a, { name: 'Agnieszka Mazur', where: 'Zabrze · ZATYRANI', what: 'Bieg 9 km · K40–49', badge: 'opłacone' })
    assert.equal(b.where, 'KB Sośnica')
    assert.equal(b.what, 'Bieg 3 km')
    assert.equal(c.badge, null)
    assert.equal(c.where, '')
  })

  it('the bars never go past 100 percent', () => {
    const v = startListView({ competitions: [{ categoryId: 'x', name: 'X', capacity: 10, paid: 9, free: 2, awaiting: 1 }], entries: [] }, { paidEvent: true })
    const c = v.competitions[0]
    assert.ok(c.paidPct + c.freePct + c.awaitingPct <= 100)
  })
})
