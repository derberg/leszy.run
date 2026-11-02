// W-13: the publish checklist (_shared/registration/checklist.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishChecklist, blockingMessage, SLUG_TAKEN_ITEM, takesMoney, moneyReason } from '../../../supabase/functions/_shared/registration/checklist.js'
import { registrationWindow } from '../../../supabase/functions/_shared/registration/dates.js'
import { PAID_REGISTRATION_ENABLED } from '../../../supabase/functions/_shared/registration/flags.js'

const window = (opensOn, closesOn) => {
  const { opensAt, closesAt } = registrationWindow({ opensOn, closesOn })
  return { opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() }
}

const comp = (over = {}) => ({
  categoryId: 'c1', name: 'Bieg 9 km', distanceLabel: '9 km', startTime: '10:00:00', capacity: 50,
  gpxUploadId: 'g1', isKids: false, hiddenAt: null, ...over,
})

// Everything filled, including the optional items.
function complete(over = {}) {
  return {
    settings: {
      name: 'Bieg Leszego', slug: 'bieg-leszego', eventDate: '2026-12-06',
      ...window('2026-11-01', '2026-12-06'),
      townLabel: 'Nieborowice', lat: 50.2381, lng: 18.5412,
      regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin', regulaminUploadId: null,
      posterUploadId: 'p1', pricingMode: 'free', contactEmail: 'zapisy@klub.example',
      ...over.settings,
    },
    competitions: over.competitions ?? [comp(), comp({ categoryId: 'c2', name: 'Bieg dzieci', distanceLabel: '400 m', isKids: true })],
    officeHours: over.officeHours ?? [{ date: '2026-12-06', from: '08:00', to: '09:30' }],
    hasAgreement: over.hasAgreement ?? true,
    payout: over.payout ?? { mode: 'club', ready: true },
  }
}

const keys = (items) => items.map((i) => i.key)

test('W-13 a complete event has nothing blocking and nothing missing', () => {
  assert.deepEqual(publishChecklist(complete()), { blocking: [], missing: [] })
})

test('W-13 an empty draft lists every required item', () => {
  const r = publishChecklist({ settings: { pricingMode: 'free' }, competitions: [], officeHours: [], hasAgreement: false })
  assert.deepEqual(keys(r.blocking), ['name', 'slug', 'event_date', 'registration_dates', 'place', 'competitions', 'regulamin', 'contact_email', 'agreement'])
  assert.deepEqual(keys(r.missing), ['office_hours', 'poster', 'kids'])
})

test('W-13 registration closing on race day is fine; closing the day after the race blocks', () => {
  assert.deepEqual(publishChecklist(complete({ settings: window('2026-11-01', '2026-12-06') })).blocking, [])
  const late = publishChecklist(complete({ settings: window('2026-11-01', '2026-12-07') }))
  assert.deepEqual(late.blocking, [{ key: 'registration_dates', label: 'Zapisy online muszą się skończyć najpóźniej w dniu zawodów' }])
})

test('W-13 the race-day bound is a Warsaw day across the DST switch (race 25.10, closes 25.10 vs 26.10)', () => {
  const base = { eventDate: '2026-10-25' }
  assert.deepEqual(publishChecklist(complete({ settings: { ...base, ...window('2026-10-01', '2026-10-25') } })).blocking, [])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { ...base, ...window('2026-10-01', '2026-10-26') } })).blocking),
    ['registration_dates'])
})

test('W-13 a missing date of the window blocks', () => {
  assert.deepEqual(keys(publishChecklist(complete({ settings: { closesAt: null } })).blocking), ['registration_dates'])
})

test('W-13 the place needs the town and the pin', () => {
  assert.deepEqual(keys(publishChecklist(complete({ settings: { lat: null } })).blocking), ['place'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { townLabel: '  ' } })).blocking), ['place'])
})

test('W-13 a competition without distance, start time or limit blocks, naming what it lacks', () => {
  const r = publishChecklist(complete({ competitions: [comp({ distanceLabel: null, startTime: null, capacity: null })] }))
  assert.deepEqual(r.blocking, [{ key: 'competition:c1', label: 'Konkurencja „Bieg 9 km”: dystans, godzina startu, limit miejsc' }])
})

test('W-13 a hidden competition does not count, so only hidden ones means none', () => {
  const r = publishChecklist(complete({ competitions: [comp({ hiddenAt: '2026-11-02T10:00:00Z', distanceLabel: null })] }))
  assert.deepEqual(keys(r.blocking), ['competitions'])
})

test('W-13 the organizer contact address is required (ruling P2-R19)', () => {
  const r = publishChecklist(complete({ settings: { contactEmail: '  ' } }))
  assert.deepEqual(r.blocking, [{ key: 'contact_email', label: 'Adres kontaktowy organizatora' }])
})

test('W-13 the regulamin is a PDF upload or a link, matching its kind', () => {
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'pdf', regulaminUrl: null, regulaminUploadId: 'u1' } })).blocking), [])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'pdf', regulaminUploadId: null } })).blocking), ['regulamin'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'link', regulaminUrl: '' } })).blocking), ['regulamin'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: null } })).blocking), ['regulamin'])
})

test('W-13 no current agreement blocks', () => {
  assert.deepEqual(keys(publishChecklist(complete({ hasAgreement: false })).blocking), ['agreement'])
})

test('W-13 a paid event with a ready payout account blocks nothing: PAID_REGISTRATION_ENABLED is true', () => {
  assert.equal(PAID_REGISTRATION_ENABLED, true)
  const r = publishChecklist(complete({ settings: { pricingMode: 'fixed' } }))
  assert.deepEqual(r.blocking, [])
  assert.deepEqual(publishChecklist(complete({ settings: { pricingMode: 'tiered' } })).blocking.filter((b) => b.key === 'payments'), [])
})

test('W-13 optional items name their wizard step and never block', () => {
  const r = publishChecklist(complete({
    settings: { posterUploadId: null }, officeHours: [], competitions: [comp({ gpxUploadId: null })],
  }))
  assert.deepEqual(r.blocking, [])
  assert.deepEqual(r.missing, [
    { key: 'office_hours', label: 'Godziny otwarcia biura zawodów', step: 'biuro' },
    { key: 'gpx:c1', label: 'Ślad GPX: Bieg 9 km', step: 'konkurencje' },
    { key: 'poster', label: 'Plakat', step: 'podstawy' },
    { key: 'kids', label: 'Dystanse dzieci', step: 'konkurencje' },
  ])
})

test('W-13 the refusal message lists the labels', () => {
  assert.equal(blockingMessage([{ key: 'a', label: 'Data zawodów' }, SLUG_TAKEN_ITEM]),
    'Uzupełnij: Data zawodów, Adres zawodów jest zajęty')
})

test('W-69 the regulamin and the organizer contact both block publish, each on its own', () => {
  const none = publishChecklist(complete({ settings: { regulaminKind: null, regulaminUrl: null, contactEmail: null } }))
  assert.deepEqual(none.blocking, [
    { key: 'regulamin', label: 'Regulamin (PDF albo link)' },
    { key: 'contact_email', label: 'Adres kontaktowy organizatora' },
  ])
  assert.equal(blockingMessage(none.blocking), 'Uzupełnij: Regulamin (PDF albo link), Adres kontaktowy organizatora')
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'link', regulaminUrl: '  ' } })).blocking), ['regulamin'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { contactEmail: null } })).blocking), ['contact_email'])
})

// P-42: a paid event needs somewhere to pay the money out (ruling P3-R1: the
// checklist sees only { mode, ready }, never the account itself).
const paid = (payout) => publishChecklist(complete({ settings: { pricingMode: 'fixed' }, payout }))

test('P-42 paid, club account, the club has payout details: nothing blocks', () => {
  assert.deepEqual(paid({ mode: 'club', ready: true }).blocking, [])
})

test('P-42 paid, club account, the club has no payout details: blocks and says where to fill them', () => {
  assert.deepEqual(paid({ mode: 'club', ready: false }).blocking,
    [{ key: 'payout', label: 'Uzupełnij dane do wypłat w ustawieniach klubu' }])
})

test('P-42 paid, another account: blocks until every field is valid', () => {
  assert.deepEqual(paid({ mode: 'custom', ready: false }).blocking,
    [{ key: 'payout', label: 'Dane do wypłat tego wydarzenia' }])
  assert.deepEqual(paid({ mode: 'custom', ready: true }).blocking, [])
})

test('P-42 paid, another account, but the club has no payout details of its own: asks for the club\'s (the Organizer, agreement §1 ust. 2)', () => {
  assert.deepEqual(paid({ mode: 'custom', ready: false, clubReady: false }).blocking,
    [{ key: 'payout', label: 'Uzupełnij dane do wypłat w ustawieniach klubu' }])
})

test('P-42 paid with no payout state at all blocks (fail closed)', () => {
  const r = publishChecklist({ ...complete({ settings: { pricingMode: 'fixed' } }), payout: undefined })
  assert.deepEqual(keys(r.blocking), ['payout'])
})

test('P-42 a free event never asks for payout details', () => {
  assert.deepEqual(publishChecklist({ ...complete(), payout: undefined }).blocking, [])
  assert.deepEqual(publishChecklist(complete({ payout: { mode: 'club', ready: false } })).blocking, [])
})

test('T-06 a visible team competition with no size blocks, inside its own competition item', () => {
  const noSize = comp({ kind: 'team', teamMin: null, teamMax: null })
  const r = publishChecklist(complete({ competitions: [noSize, comp({ categoryId: 'c2', isKids: true })] }))
  assert.deepEqual(r.blocking, [{ key: 'competition:c1', label: 'Konkurencja „Bieg 9 km”: skład drużyny' }])
})

test('T-06 the size gap joins the competition\'s other gaps, and either bound missing counts', () => {
  const r = publishChecklist(complete({ competitions: [comp({ kind: 'team', teamMin: 3, teamMax: null, distanceLabel: ' ' }), comp({ categoryId: 'c2', isKids: true })] }))
  assert.deepEqual(r.blocking, [{ key: 'competition:c1', label: 'Konkurencja „Bieg 9 km”: dystans, skład drużyny' }])
})

test('T-06 a team with a size, a hidden team and an individual competition do not block', () => {
  const teams = [comp({ kind: 'team', teamMin: 3, teamMax: 5 }), comp({ categoryId: 'c2', isKids: true })]
  assert.deepEqual(publishChecklist(complete({ competitions: teams })).blocking, [])
  const hidden = [comp({ kind: 'team', hiddenAt: '2026-10-01' }), comp({ categoryId: 'c2', isKids: true })]
  assert.deepEqual(publishChecklist(complete({ competitions: hidden })).blocking, [])
})

// ---------------------------------------------------------------- V-20 (D7-22)

// An event takes money when its pricing mode is not free, or it has a priced extra, or donations
// are on (a charity event with „Pozwól dopłacić darowiznę”, ruling 7). Each then needs a payout
// account. With PAID_REGISTRATION_ENABLED true nothing else holds it.
const PAYOUT_CLUB = { key: 'payout', label: 'Uzupełnij dane do wypłat w ustawieniach klubu' }

test('V-20 a free event with donations on and no payout → the blocking payout item', () => {
  const r = publishChecklist(complete({ settings: { isCharity: true, donationsEnabled: true }, payout: { mode: 'club', ready: false } }))
  assert.deepEqual(r.blocking, [PAYOUT_CLUB])
  const ready = publishChecklist(complete({ settings: { isCharity: true, donationsEnabled: true } }))
  assert.deepEqual(ready.blocking, [], 'with a ready payout account a charity event with donations publishes')
})

test('V-20 a free event with a priced extra and no payout → the blocking payout item; a 0 zł extra asks nothing', () => {
  const priced = publishChecklist({ ...complete({ payout: { mode: 'club', ready: false } }), extras: [{ price: 4500 }] })
  assert.deepEqual(priced.blocking, [PAYOUT_CLUB])
  assert.deepEqual(publishChecklist({ ...complete(), extras: [{ price: 4500 }] }).blocking, [], 'payout ready: publishes')
  const gratis = publishChecklist({ ...complete({ payout: { mode: 'club', ready: false } }), extras: [{ price: 0 }] })
  assert.deepEqual(gratis.blocking, [])
})

test('V-20 donations switched on outside a charity event take no money (ruling 7)', () => {
  assert.deepEqual(publishChecklist(complete({ settings: { isCharity: false, donationsEnabled: true }, payout: { mode: 'club', ready: false } })).blocking, [])
})

test('V-20 takesMoney: pricing mode, a priced extra or donations on', () => {
  assert.equal(takesMoney({ settings: { pricingMode: 'free' } }), false)
  assert.equal(takesMoney({ settings: { pricingMode: 'fixed' } }), true)
  assert.equal(takesMoney({ settings: { pricingMode: 'tiered' } }), true)
  assert.equal(takesMoney({ settings: { pricingMode: 'free' }, extras: [{ price: 0 }, { price: 1 }] }), true)
  assert.equal(takesMoney({ settings: { pricingMode: 'free', isCharity: true, donationsEnabled: true } }), true)
  assert.equal(takesMoney({ settings: { pricingMode: 'free', isCharity: true, donationsEnabled: false } }), false)
  assert.equal(takesMoney({}), false)
})

test('M-2 moneyReason: the pricing mode first, then priced extras, then donations', () => {
  assert.equal(moneyReason({ settings: { pricingMode: 'fixed', isCharity: true, donationsEnabled: true } }), 'pricing')
  assert.equal(moneyReason({ settings: { pricingMode: 'free', isCharity: true, donationsEnabled: true }, extras: [{ price: 1 }] }), 'extras')
  assert.equal(moneyReason({ settings: { pricingMode: 'free', isCharity: true, donationsEnabled: true } }), 'donations')
  assert.equal(moneyReason({ settings: { pricingMode: 'free' } }), null)
})

// ---------------------------------------------------------------- fix round 1: I-1, M-4

const TRANSFER_LATE = { key: 'transfer_until', label: 'Przekazanie pakietu: najpóźniej dzień przed zawodami' }
const TRANSFER_DATE = { key: 'transfer_until', label: 'Przekazanie pakietu: podaj, do kiedy' }
const ORDER_LATE = { key: 'extras_order_until', label: 'Dodatki: zamówienia najpóźniej w dniu zawodów' }

test('I-1 the transfer window is judged on the event as it is: the race moved earlier blocks, the day before passes', () => {
  const at = (settings) => publishChecklist(complete({ settings: { transferEnabled: true, ...settings } })).blocking
  assert.deepEqual(at({ transferUntil: '2026-12-05' }), [])
  assert.deepEqual(at({ transferUntil: '2026-12-06' }), [TRANSFER_LATE])
  assert.deepEqual(at({ transferUntil: '2026-12-05', eventDate: '2026-12-05', ...window('2026-11-01', '2026-12-05') }), [TRANSFER_LATE])
  assert.deepEqual(at({ transferUntil: null }), [TRANSFER_DATE])
  assert.deepEqual(publishChecklist(complete({ settings: { transferEnabled: false, transferUntil: '2026-12-31' } })).blocking, [],
    'switched off, a stale date asks nothing')
})

test('I-1 an extra ordered after the race day blocks, in either spelling of the extras', () => {
  const free = (extras) => publishChecklist({ ...complete(), extras }).blocking
  assert.deepEqual(free([{ price: 0, orderUntil: '2026-12-06' }]), [])
  assert.deepEqual(free([{ price: 0, orderUntil: '2026-12-07' }]), [ORDER_LATE])
  assert.deepEqual(free([{ price: 0, order_until: '2026-12-07' }]), [ORDER_LATE])
})

test('M-4 tiers are checked against the window as it is: a tier ending on or after the last open day blocks', () => {
  const tiered = (tiers, over = {}) => publishChecklist({ ...complete({ settings: { pricingMode: 'tiered', ...over } }), tiers })
    .blocking.filter((b) => b.key === 'tiers')
  assert.deepEqual(tiered([{ endsOn: '2026-11-15' }, { endsOn: '2026-11-25' }, { endsOn: null }]), [])
  assert.deepEqual(tiered([{ ends_on: '2026-11-15' }, { ends_on: null }]), [], 'the staged spelling')
  const late = tiered([{ endsOn: '2026-11-15' }, { endsOn: '2026-11-25' }, { endsOn: null }], window('2026-11-01', '2026-11-20'))
  assert.deepEqual(late, [{ key: 'tiers', label: 'Progi cenowe: Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.' }])
  assert.equal(tiered([], {}).length, 1, 'tiered with no tiers')
  assert.deepEqual(publishChecklist({ ...complete({ settings: { pricingMode: 'fixed' } }), tiers: [{ endsOn: '2030-01-01' }] })
    .blocking.filter((b) => b.key === 'tiers'), [], 'only tiered pricing has tiers to check')
})
