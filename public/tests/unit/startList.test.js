import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterStartList, startListFilterOptions, startListView } from '../../src/lib/startList.js'

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
  it('per competition: paid entries of capacity (P3-R15), the bars, „+N czeka na wpłatę” as a count only', () => {
    const v = startListView(SNAP, { paidEvent: true })
    assert.deepEqual(v.competitions[0], {
      categoryId: 'c1', name: 'Bieg 9 km', taken: 32, capacity: 80, paidPct: 40, freePct: 0,
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
    assert.deepEqual(a, {
      name: 'Agnieszka Mazur', town: 'Zabrze', club: 'ZATYRANI', categoryId: 'c1', competition: 'Bieg 9 km',
      category: 'K40–49', gender: null, where: 'Zabrze · ZATYRANI', what: 'Bieg 9 km · K40–49', badge: 'opłacone',
    })
    assert.equal(b.where, 'KB Sośnica')
    assert.equal(b.what, 'Bieg 3 km')
    assert.equal(c.badge, null)
    assert.equal(c.where, '')
  })

  it('the bars never go past 100 percent', () => {
    const v = startListView({ competitions: [{ categoryId: 'x', name: 'X', capacity: 10, paid: 9, free: 2, awaiting: 1 }], entries: [] }, { paidEvent: true })
    const c = v.competitions[0]
    assert.ok(c.paidPct + c.freePct <= 100)
  })

  it('P3-R15 entries awaiting payment hold no place: „N / limit” and the bar leave them out', () => {
    const v = startListView({ competitions: [{ categoryId: 'x', name: 'X', capacity: 2, paid: 0, free: 0, awaiting: 5 }], entries: [] }, { paidEvent: true })
    const c = v.competitions[0]
    assert.equal(c.taken, 0)
    assert.equal(c.paidPct + c.freePct, 0)
    assert.equal(c.awaitingLabel, '+5 czeka na wpłatę')
    assert.ok(!('awaitingPct' in c))
  })
})

// Plan 4 task 7 (G-42, G-43): RA8/RA8d filters over the same snapshot. start_list()
// adds `gender` and `kidsGroupLabel`; the order is start_list's (pl-PL collation).
const FULL = {
  competitions: [
    { categoryId: 'c1', name: 'Bieg 9 km', capacity: 80, paid: 3, free: 0, awaiting: 1 },
    { categoryId: 'c2', name: 'NW 9 km', capacity: 40, paid: 1, free: 0, awaiting: 0 },
    { categoryId: 'c3', name: 'Bieg dzieci', capacity: 20, paid: 0, free: 1, awaiting: 0 },
  ],
  entries: [
    { name: 'Agnieszka Mazur', town: 'Zabrze', club: 'ZATYRANI', categoryId: 'c1', competition: 'Bieg 9 km', ageGroupLabel: 'K40–49', kidsGroupLabel: null, gender: 'K', payment: 'paid' },
    { name: 'Tomasz Łoś', town: 'Gliwice', club: null, categoryId: 'c1', competition: 'Bieg 9 km', ageGroupLabel: 'M30–39', kidsGroupLabel: null, gender: 'M', payment: 'paid' },
    { name: 'Paweł Zieliński', town: 'Bytom', club: 'KB Sośnica', categoryId: 'c1', competition: 'Bieg 9 km', ageGroupLabel: 'M30–39', kidsGroupLabel: null, gender: 'M', payment: 'paid' },
    { name: 'Grażyna Wiśniewska', town: 'Pyskowice', club: 'Kijki Pyskowice', categoryId: 'c2', competition: 'NW 9 km', ageGroupLabel: 'K50–59', kidsGroupLabel: null, gender: 'K', payment: 'paid' },
    { name: 'Zosia Wiśniewska', town: null, club: null, categoryId: 'c3', competition: 'Bieg dzieci', ageGroupLabel: 'K dzieci', kidsGroupLabel: 'Dzieci I', gender: 'K', payment: 'free' },
  ],
}
const ALL = { categoryId: '', category: '', gender: '', club: '', q: '' }
const names = (r) => r.entries.map((e) => e.name)

describe('G-42 filterStartList (RA8/RA8d filters)', () => {
  const v = startListView(FULL, { paidEvent: true })

  it('the kids-group label is the category of a kids entry, the age group otherwise', () => {
    assert.equal(v.entries[4].category, 'Dzieci I')
    assert.equal(v.entries[4].what, 'Bieg dzieci · Dzieci I')
    assert.equal(v.entries[0].category, 'K40–49')
    assert.equal(v.entries[0].gender, 'K')
  })

  it('no filter → everyone, in start_list order; total is the whole list', () => {
    const r = filterStartList(v, ALL)
    assert.deepEqual(names(r), FULL.entries.map((e) => e.name))
    assert.equal(r.total, 5)
    assert.deepEqual(names(filterStartList(v, {})), FULL.entries.map((e) => e.name))
  })

  it('each filter alone', () => {
    assert.deepEqual(names(filterStartList(v, { ...ALL, categoryId: 'c2' })), ['Grażyna Wiśniewska'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, category: 'M30–39' })), ['Tomasz Łoś', 'Paweł Zieliński'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, category: 'Dzieci I' })), ['Zosia Wiśniewska'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, category: 'K dzieci' })), [], 'a kids entry is filtered by its kids group')
    assert.deepEqual(names(filterStartList(v, { ...ALL, gender: 'M' })), ['Tomasz Łoś', 'Paweł Zieliński'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, club: 'ZATYRANI' })), ['Agnieszka Mazur'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, club: '__none' })), ['Tomasz Łoś', 'Zosia Wiśniewska'])
    assert.equal(filterStartList(v, { ...ALL, gender: 'M' }).total, 5)
  })

  it('search: name, town and club, case- and diacritic-insensitive', () => {
    assert.deepEqual(names(filterStartList(v, { ...ALL, q: 'wisniewska' })), ['Grażyna Wiśniewska', 'Zosia Wiśniewska'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, q: 'LOS' })), ['Tomasz Łoś'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, q: 'gliwice' })), ['Tomasz Łoś'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, q: 'sosnica' })), ['Paweł Zieliński'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, q: '  kijki  ' })), ['Grażyna Wiśniewska'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, q: '1985' })), [])
  })

  it('combined filters narrow; one that matches nothing gives an empty list', () => {
    assert.deepEqual(names(filterStartList(v, { ...ALL, categoryId: 'c1', gender: 'M', club: '__none' })), ['Tomasz Łoś'])
    assert.deepEqual(names(filterStartList(v, { ...ALL, gender: 'K', q: 'wisniewska', categoryId: 'c3' })), ['Zosia Wiśniewska'])
    const none = filterStartList(v, { ...ALL, categoryId: 'c2', gender: 'M' })
    assert.deepEqual(none.entries, [])
    assert.equal(none.total, 5)
  })

  it('options: competitions in card order, categories and clubs in Polish order, „Bez klubu” only when someone has no club', () => {
    const o = startListFilterOptions(v)
    assert.deepEqual(o.competitions, [{ value: 'c1', label: 'Bieg 9 km' }, { value: 'c2', label: 'NW 9 km' }, { value: 'c3', label: 'Bieg dzieci' }])
    assert.deepEqual(o.categories, ['Dzieci I', 'K40–49', 'K50–59', 'M30–39'])
    assert.deepEqual(o.genders, [{ value: 'K', label: 'Kobiety' }, { value: 'M', label: 'Mężczyźni' }])
    assert.deepEqual(o.clubs, [
      { value: 'KB Sośnica', label: 'KB Sośnica' }, { value: 'Kijki Pyskowice', label: 'Kijki Pyskowice' },
      { value: 'ZATYRANI', label: 'ZATYRANI' }, { value: '__none', label: 'Bez klubu' },
    ])
    const allClubs = startListFilterOptions(startListView({ ...FULL, entries: FULL.entries.slice(0, 1) }, { paidEvent: true }))
    assert.deepEqual(allClubs.clubs, [{ value: 'ZATYRANI', label: 'ZATYRANI' }])
  })
})

describe('G-43 a free event never mentions payment', () => {
  it('every entry free, no badge, no payment text anywhere in the view', () => {
    const snap = {
      competitions: [{ categoryId: 'f1', name: 'Bieg 5 km', capacity: 50, paid: 0, free: 2, awaiting: 0 }],
      entries: [
        { name: 'Ola Leśna', town: 'Gliwice', club: null, categoryId: 'f1', competition: 'Bieg 5 km', ageGroupLabel: 'K open', kidsGroupLabel: null, gender: 'K', payment: 'free' },
        { name: 'Jan Bór', town: null, club: 'ZATYRANI', categoryId: 'f1', competition: 'Bieg 5 km', ageGroupLabel: 'M open', kidsGroupLabel: null, gender: 'M', payment: 'free' },
      ],
    }
    const v = startListView(snap, { paidEvent: false })
    assert.ok(v.entries.every((e) => e.badge === null))
    const text = JSON.stringify([v, startListFilterOptions(v), filterStartList(v, {})])
    assert.ok(!/opłac|wpłat|płatn/i.test(text), text)
  })
})
