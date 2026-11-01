import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AWAITING_CONSENT, entryActions, entryCounts, filterEntries } from '../../src/lib/entriesModel.js'

const row = (over = {}) => ({
  id: 'r', name: 'Anna Nowak', firstName: 'Anna', lastName: 'Nowak', email: 'anna@example.pl', bib: null, categoryId: 'c1',
  status: 'confirmed', statusKey: 'paid', consentState: 'accepted', team: null, partnerId: null,
  paidAmount: 6000, refunded: 0, refundUnconfirmed: 0, lines: [{ id: 'l', kind: 'entry', amount: 6000, refunded: 0 }], ...over,
})
const COMPETITIONS = [
  { id: 'c1', name: 'Bieg 9 km', capacity: 10, taken: 3, kind: 'individual' },
  { id: 'c2', name: 'Sztafeta', capacity: 5, taken: 1, kind: 'team' },
]

describe('filterEntries (O-03)', () => {
  const rows = [
    row({ id: 'a', name: 'Anna Wiśniewska', lastName: 'Wiśniewska', bib: 214 }),
    row({ id: 'b', name: 'Paweł Łoś', lastName: 'Łoś', email: 'PAWEL@example.pl', categoryId: 'c2', team: { id: 't', name: 'Leśne Dziki' }, partnerId: 'p1' }),
    row({ id: 'c', name: 'Ola Mała', statusKey: 'awaiting', status: 'pending_payment', email: 'ola@example.pl' }),
    row({ id: 'd', name: 'Iga Lis', consentState: 'awaiting', email: 'iga@example.pl' }),
    row({ id: 'e', name: 'Jan Lis', status: 'pending_payment', statusKey: 'awaiting', consentState: 'awaiting', email: 'jan@example.pl' }),
  ]
  const ids = (filters) => filterEntries(rows, filters).map((r) => r.id)

  it('without filters returns everybody', () => assert.deepEqual(ids({}), ['a', 'b', 'c', 'd', 'e']))
  it('finds a name whatever the case and the diacritics', () => {
    assert.deepEqual(ids({ q: 'wisniewska' }), ['a'])
    assert.deepEqual(ids({ q: 'WIŚNIEWSKA' }), ['a'])
    assert.deepEqual(ids({ q: 'los' }), ['b'])
  })
  it('finds a bib', () => assert.deepEqual(ids({ q: '214' }), ['a']))
  it('finds an e-mail', () => assert.deepEqual(ids({ q: 'pawel@' }), ['b']))
  it('finds a team name', () => assert.deepEqual(ids({ q: 'lesne dziki' }), ['b']))
  it('filters by competition, status and partner, together', () => {
    assert.deepEqual(ids({ categoryId: 'c2' }), ['b'])
    assert.deepEqual(ids({ statusKey: 'awaiting' }), ['c', 'e'])
    assert.deepEqual(ids({ partnerId: 'p1' }), ['b'])
    assert.deepEqual(ids({ categoryId: 'c1', statusKey: 'awaiting', q: 'ola' }), ['c'])
  })
  it('„Czeka na zgody” holds confirmed entries only, as its count does', () => {
    assert.deepEqual(ids({ statusKey: AWAITING_CONSENT }), ['d'])
  })
})

describe('entryCounts', () => {
  const rows = [
    row({ id: 'a' }),
    row({ id: 'b', statusKey: 'free', paidAmount: 0, lines: [], consentState: 'awaiting' }),
    row({ id: 'c', refunded: 2000, lines: [{ id: 'l3', kind: 'entry', amount: 6000, refunded: 2000 }] }),
    row({ id: 'd', status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0, consentState: 'awaiting' }),
    row({ id: 'e', status: 'expired', statusKey: 'expired', paidAmount: 0 }),
    row({ id: 'f', status: 'pending_payment', statusKey: 'expired', paidAmount: 0 }),
    row({ id: 'g', status: 'cancelled', statusKey: 'cancelled', refunded: 6000, lines: [{ id: 'l7', kind: 'entry', amount: 6000, refunded: 6000 }] }),
    row({ id: 'h', status: 'cancelled', statusKey: 'withdraw_on_host', refunded: 6000, lines: [{ id: 'l8', kind: 'entry', amount: 6000, refunded: 6000 }] }),
    // One team, one slot, one fee: only the captain carries a line.
    row({ id: 't1', categoryId: 'c2', team: { id: 't' }, lines: [{ id: 'l9', kind: 'entry', amount: 20000, refunded: 0 }], paidAmount: 20000 }),
    row({ id: 't2', categoryId: 'c2', team: { id: 't' }, lines: [], paidAmount: 0 }),
    row({ id: 't3', categoryId: 'c2', team: { id: 't' }, lines: [], paidAmount: 0 }),
  ]
  const counts = entryCounts(rows, COMPETITIONS)

  it('listed equals the competitions\' taken: confirmed entries, a team once', () => {
    const taken = (kind) => COMPETITIONS.filter((c) => c.kind === kind).reduce((n, c) => n + c.taken, 0)
    assert.deepEqual(counts.listed, { people: taken('individual'), teams: taken('team') })
  })
  it('people and teams never add up into one number: listed and capacity keep them apart', () => {
    assert.deepEqual(counts.listed, { people: 3, teams: 1 })
    assert.deepEqual(counts.capacity, { people: 10, teams: 5 })
    const peopleOnly = entryCounts([row({ id: 'x' })], [COMPETITIONS[0]])
    assert.deepEqual(peopleOnly.listed, { people: 1, teams: 0 })
    assert.deepEqual(peopleOnly.capacity, { people: 10, teams: 0 })
  })
  it('awaiting stays outside listed and the limit (D6-14), a lapsed deadline is not awaiting', () => {
    assert.equal(counts.awaiting, 1)
    assert.equal(counts.expired, 2)
  })
  it('cancelled counts every cancelled entry, whatever its status key (F3)', () => {
    assert.equal(counts.cancelled, 2)
    const extra = [row({ status: 'cancelled', statusKey: 'refund_unconfirmed', refunded: 2000, refundUnconfirmed: 2000 })]
    assert.equal(entryCounts([...rows, ...extra], COMPETITIONS).cancelled, 3)
    assert.equal(counts.byStatus.withdraw_on_host, 1)
    assert.equal(counts.byStatus.paid, 5)
  })
  it('awaitingConsent counts confirmed entries only', () => assert.equal(counts.awaitingConsent, 1))
  it('clubIncome: paid lines minus accepted refunds', () => {
    assert.equal(counts.clubIncome, 6000 + 0 + (6000 - 2000) + 0 + 0 + 20000)
  })
  it('an unconfirmed refund has not left the club', () => {
    const r = row({ statusKey: 'refund_unconfirmed', refunded: 3000, refundUnconfirmed: 1000, lines: [{ id: 'l', kind: 'entry', amount: 6000, refunded: 3000 }] })
    assert.equal(entryCounts([r], COMPETITIONS).clubIncome, 4000)
  })
  it('an unpaid order brings in nothing', () => {
    assert.equal(entryCounts([row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 })], COMPETITIONS).clubIncome, 0)
  })
  it('perCompetition keeps each competition with its own numbers', () => {
    assert.deepEqual(counts.perCompetition, [
      { id: 'c1', name: 'Bieg 9 km', kind: 'individual', capacity: 10, listed: 3, awaiting: 1 },
      { id: 'c2', name: 'Sztafeta', kind: 'team', capacity: 5, listed: 1, awaiting: 0 },
    ])
  })
})

describe('entryActions (O-06)', () => {
  const open = { closed: false, raceDay: false, isTeamRow: false }

  it('a paid entry before close', () => {
    assert.deepEqual(entryActions(row(), open), ['edit', 'message', 'refund', 'cancel'])
  })
  it('refund is absent on race day and for unpaid rows', () => {
    assert.ok(!entryActions(row(), { ...open, raceDay: true }).includes('refund'))
    assert.ok(!entryActions(row({ statusKey: 'free', paidAmount: 0, lines: [] }), open).includes('refund'))
    assert.ok(!entryActions(row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 }), open).includes('refund'))
  })
  it('refund is absent once nothing is left to return, present on a cancelled entry with money left', () => {
    const full = { paidAmount: 6000, refunded: 6000, lines: [{ id: 'l', kind: 'entry', amount: 6000, refunded: 6000 }] }
    assert.ok(!entryActions(row(full), open).includes('refund'))
    assert.deepEqual(entryActions(row({ status: 'cancelled', statusKey: 'cancelled' }), open), ['refund'])
  })
  it('edit is absent when closed', () => {
    assert.ok(!entryActions(row(), { ...open, closed: true }).includes('edit'))
    assert.deepEqual(entryActions(row(), { ...open, closed: true }), ['message', 'refund', 'cancel'])
  })
  it('extend and the payment reminder are for an order still awaiting, before close', () => {
    const awaiting = row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 })
    assert.deepEqual(entryActions(awaiting, open), ['edit', 'remind_payment', 'extend', 'message', 'cancel'])
    assert.ok(!entryActions(awaiting, { ...open, closed: true }).includes('extend'))
    assert.ok(!entryActions(row({ status: 'pending_payment', statusKey: 'expired', paidAmount: 0 }), open).includes('extend'))
    for (const statusKey of ['free', 'paid', 'cancelled', 'refund_unconfirmed']) {
      assert.ok(!entryActions(row({ statusKey }), open).includes('extend'), statusKey)
    }
  })
  it('the consent controls follow a confirmed entry still waiting', () => {
    const actions = entryActions(row({ consentState: 'awaiting' }), open)
    assert.ok(actions.includes('remind_consent') && actions.includes('consent_office'))
    assert.ok(!entryActions(row({ status: 'pending_payment', statusKey: 'awaiting', consentState: 'awaiting' }), open).includes('remind_consent'))
  })
  it('rename_team and squad only on team rows, which are not one person', () => {
    assert.ok(!entryActions(row(), open).includes('rename_team'))
    assert.ok(!entryActions(row(), open).includes('squad'))
    assert.deepEqual(entryActions(row({ consentState: 'awaiting' }), { ...open, isTeamRow: true }), ['message', 'refund', 'cancel', 'rename_team', 'squad'])
  })
  it('a transferred entry\'s money is not refunded from its old row', () => {
    assert.ok(!entryActions(row({ status: 'transferred_out', statusKey: 'transferred' }), open).includes('refund'))
  })
  it('a finished row offers nothing', () => {
    for (const [status, statusKey] of [['expired', 'expired'], ['transferred_out', 'transferred']]) {
      assert.deepEqual(entryActions(row({ status, statusKey, paidAmount: 0 }), open), [])
    }
    assert.deepEqual(entryActions(row({ status: 'pending_payment', statusKey: 'expired', paidAmount: 0 }), { ...open, isTeamRow: true }), [])
  })
})
