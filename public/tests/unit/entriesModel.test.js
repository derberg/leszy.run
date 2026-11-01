import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AWAITING_CONSENT, actionLabel, competitionChips, entryActions, extendChoices, entryCounts, filterEntries, listedTile, noPlacesForAwaiting, statusChips,
} from '../../src/lib/entriesModel.js'

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
    assert.deepEqual(entryActions(row(), open), ['edit', 'message', 'refund', 'cancel', 'partner'])
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
    assert.deepEqual(entryActions(row(), { ...open, closed: true }), ['message', 'refund', 'cancel', 'partner'])
  })
  it('extend and the payment reminder are for an order still awaiting, before close', () => {
    const awaiting = row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 })
    assert.deepEqual(entryActions(awaiting, open), ['edit', 'remind_payment', 'extend', 'message', 'cancel', 'partner'])
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
  it('partner (Plan 7, V-33) on a live person row only: not a team row, not a lapsed or finished one', () => {
    assert.ok(entryActions(row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 }), open).includes('partner'))
    assert.ok(!entryActions(row(), { ...open, isTeamRow: true }).includes('partner'))
    for (const [status, statusKey] of [['cancelled', 'cancelled'], ['pending_payment', 'expired'], ['transferred_out', 'transferred']]) {
      assert.ok(!entryActions(row({ status, statusKey }), open).includes('partner'), statusKey)
    }
  })
  it('a transferred entry\'s money is not refunded from its old row', () => {
    assert.ok(!entryActions(row({ status: 'transferred_out', statusKey: 'transferred' }), open).includes('refund'))
  })
  it('the payment items stop an hour before close, as the server does (paying_closed)', () => {
    const awaiting = row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 })
    assert.deepEqual(entryActions(awaiting, { ...open, payingClosed: true }), ['edit', 'message', 'cancel', 'partner'])
  })
  it('no payment reminder in a full competition, which the server refuses (D6-27); the extension stays', () => {
    const awaiting = row({ status: 'pending_payment', statusKey: 'awaiting', paidAmount: 0 })
    assert.deepEqual(entryActions(awaiting, { ...open, full: true }), ['edit', 'extend', 'message', 'cancel', 'partner'])
  })
  it('a finished row offers nothing', () => {
    for (const [status, statusKey] of [['expired', 'expired'], ['transferred_out', 'transferred']]) {
      assert.deepEqual(entryActions(row({ status, statusKey, paidAmount: 0 }), open), [])
    }
    assert.deepEqual(entryActions(row({ status: 'pending_payment', statusKey: 'expired', paidAmount: 0 }), { ...open, isTeamRow: true }), [])
  })
})

describe('the panel\'s tiles and chips (O-50)', () => {
  const counts = (over = {}) => ({
    listed: { people: 31, teams: 2 }, capacity: { people: 50, teams: 10 }, awaitingConsent: 3,
    byStatus: { paid: 30, awaiting: 4, free: 1 },
    perCompetition: [{ kind: 'individual', capacity: 50, listed: 31, awaiting: 4 }, { kind: 'team', capacity: 10, listed: 2, awaiting: 0 }],
    ...over,
  })

  it('„NA LIŚCIE” keeps people and teams apart, and shows one kind alone', () => {
    assert.equal(listedTile(counts()), '31 / 50 · 2 / 10 DRUŻYN')
    assert.equal(listedTile(counts({ perCompetition: [{ kind: 'individual' }] })), '31 / 50')
    assert.equal(listedTile(counts({ perCompetition: [{ kind: 'team' }], capacity: { people: 0, teams: 1 } })), '2 / 1 DRUŻYNA')
    assert.equal(listedTile(counts({ perCompetition: [{ kind: 'team' }], capacity: { people: 0, teams: 3 } })), '2 / 3 DRUŻYNY')
  })

  it('„BRAK MIEJSC” only where a full competition holds an unpaid entry', () => {
    assert.equal(noPlacesForAwaiting(counts()), false)
    assert.equal(noPlacesForAwaiting(counts({ perCompetition: [{ kind: 'individual', capacity: 2, listed: 2, awaiting: 1 }] })), true)
    assert.equal(noPlacesForAwaiting(counts({ perCompetition: [{ kind: 'individual', capacity: 2, listed: 2, awaiting: 0 }] })), false)
  })

  it('competition chips count rows, and a team competition its teams', () => {
    const rows = [
      row({ id: 'a' }), row({ id: 'b' }),
      row({ id: 'c', categoryId: 'c2', team: { id: 't1' } }), row({ id: 'd', categoryId: 'c2', team: { id: 't1' } }),
      row({ id: 'e', categoryId: 'c2', team: { id: 't2' } }),
    ]
    assert.deepEqual(competitionChips(rows, COMPETITIONS).map((c) => c.label), ['Wszystkie · 5', 'Bieg 9 km · 2', 'Sztafeta · 2 drużyny'])
    assert.deepEqual(competitionChips([], COMPETITIONS).map((c) => c.label), ['Wszystkie · 0', 'Bieg 9 km · 0', 'Sztafeta · 0 drużyn'])
  })

  it('a released team is not counted; its people and a cancelled member count as people', () => {
    const rows = [
      row({ id: 'c', categoryId: 'c2', team: { id: 't1' } }), row({ id: 'd', categoryId: 'c2', team: { id: 't1' } }),
      row({ id: 'x', categoryId: 'c2', status: 'cancelled', statusKey: 'cancelled', team: { id: 't1' } }),
      row({ id: 'e', categoryId: 'c2', status: 'cancelled', statusKey: 'cancelled', team: { id: 't2' } }),
    ]
    assert.equal(competitionChips(rows, COMPETITIONS, [{ id: 't1' }])[2].label, 'Sztafeta · 1 drużyna · 2 os.')
  })

  it('status chips: „Do wycofania w pomiarze” only when somebody is to be withdrawn', () => {
    const labels = (c) => statusChips(c).map((x) => x.label)
    assert.deepEqual(labels(counts()), ['Wszystkie', 'Opłacone · 30', 'Czeka na wpłatę · 4', 'Czeka na zgody · 3', 'Wygasłe · 0', 'Anulowane · 0'])
    assert.ok(labels(counts({ byStatus: { withdraw_on_host: 2 } })).includes('Do wycofania w pomiarze · 2'))
    assert.equal(statusChips(counts()).find((c) => c.label.startsWith('Czeka na zgody')).key, AWAITING_CONSENT)
  })

  it('⋯ labels: the captain for a team row, the unpaid cancel by its own name', () => {
    assert.equal(actionLabel('message', row()), 'Napisz do zawodnika')
    assert.equal(actionLabel('message', row(), { isTeamRow: true }), 'Napisz do kapitana')
    assert.equal(actionLabel('cancel', row()), 'Anuluj zgłoszenie')
    assert.equal(actionLabel('cancel', row({ statusKey: 'awaiting' })), 'Anuluj nieopłacone zgłoszenie')
    for (const a of ['edit', 'remind_payment', 'extend', 'remind_consent', 'consent_office', 'refund', 'rename_team', 'squad']) {
      assert.ok(actionLabel(a, row()))
    }
    assert.throws(() => actionLabel('nope', row()))
  })
})

describe('actionLabel', () => {
  it('cancel on a team row or the captain\'s own row cancels the team', () => {
    assert.equal(actionLabel('cancel', row(), { isTeamRow: true }), 'Anuluj drużynę')
    assert.equal(actionLabel('cancel', row(), { isCaptain: true }), 'Anuluj drużynę')
    assert.equal(actionLabel('cancel', row()), 'Anuluj zgłoszenie')
    assert.equal(actionLabel('cancel', row({ statusKey: 'awaiting' })), 'Anuluj nieopłacone zgłoszenie')
  })
})

describe('extendChoices (ExtendDialog)', () => {
  const now = new Date('2026-11-01T12:00:00Z')
  const at = (days) => new Date(now.getTime() + days * 86_400_000).toISOString()
  const untils = (o) => extendChoices({ now, ...o }).map((c) => c.until?.toISOString() ?? null)

  const margin = 10 * 60_000
  it('+ 7 and + 14 days count from the current deadline, never past 14 days from now less a margin for the clock', () => {
    assert.deepEqual(untils({ expiresAt: at(2), closesAt: at(30) }),
      [at(9), new Date(now.getTime() + 14 * 86_400_000 - margin).toISOString(), null])
  })
  it('every choice is capped at closes_at; one landing where an earlier one does is disabled', () => {
    assert.deepEqual(untils({ expiresAt: at(2), closesAt: at(5) }), [at(5), null, null])
    assert.deepEqual(untils({ expiresAt: at(1), closesAt: at(10) }), [at(8), at(10), null])
  })
  it('a choice that would not move the deadline forward is disabled', () => {
    assert.deepEqual(untils({ expiresAt: at(5), closesAt: at(5) }), [null, null, null])
  })
})
