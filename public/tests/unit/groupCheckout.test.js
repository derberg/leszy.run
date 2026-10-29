import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { backToForm, checkoutModel, repriceLines } from '../../src/lib/checkout.js'
import { canRemind, consentTag, orderPeople, remindLabel, showsConsentTags } from '../../src/lib/consentTag.js'

// G-46 (Plan 4 task 5b): RA4 for a group and the RA5 consent tags.
// RA4: one line per person at that person's competition price, the amounts over every
// line, a price_changed answer re-pricing every line (never a stale line beside a new
// total), and the refusals that send the payer back to the form's cards.
// RA5: „✓ REGULAMIN” / „✓ OPIEKUN” / „CZEKA NA ZGODĘ” per person, and the reminder for an
// added adult who has not accepted yet.

const lines = [
  { key: 'a', name: 'Ola Leśna', competitionName: 'Bieg 9 km', ageGroupLabel: 'K30', priceGrosze: 6000 },
  { key: 'b', name: 'Piotr Leśny', competitionName: 'Bieg 9 km', ageGroupLabel: 'M30', priceGrosze: 6000 },
  { key: 'c', name: 'Zosia Leśna', competitionName: 'Bieg dzieci 1 km', ageGroupLabel: 'Dzieci 2015–2017', priceGrosze: 2000 },
]

describe('G-46 RA4 for a group', () => {
  it('the amounts run over every person\'s price', () => {
    const m = checkoutModel({ entryPrices: lines.map((l) => l.priceGrosze), choice: false })
    assert.equal(m.amounts.entryTotal, 14000)
    assert.equal(m.entryLabel, '140,00 zł')
    assert.equal(m.payDisabled, false)
  })

  it('price_changed with each person\'s new price re-prices every line, in order', () => {
    const next = repriceLines(lines, { entryTotal: 15000, entryPrices: [6500, 6500, 2000], total: 15135 })
    assert.deepEqual(next.map((l) => l.priceGrosze), [6500, 6500, 2000])
    assert.deepEqual(next.map((l) => l.name), lines.map((l) => l.name))
    // the input is not changed
    assert.equal(lines[0].priceGrosze, 6000)
  })

  it('one person and only the entry total (the single-person answer) → that line takes it', () => {
    const next = repriceLines([lines[0]], { entryTotal: 6500, total: 6559 })
    assert.deepEqual(next.map((l) => l.priceGrosze), [6500])
  })

  it('a group answer the lines cannot be priced from → null (the page starts again), never stale lines', () => {
    assert.equal(repriceLines(lines, { total: 15135 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 15000, total: 15135 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 15000, entryPrices: [6500, 6500], total: 15135 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 99, entryPrices: [6500, 6500, 2000], total: 15135 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 15000, entryPrices: [6500, '6500', 2000], total: 15135 }), null)
    assert.equal(repriceLines(lines, null), null)
  })

  it('back to the form: a person\'s refusal, a full competition the server names, the generic group refusal, no session', () => {
    const err = (status, code, extra = {}) => Object.assign(new Error('x'), { status, code, ...extra })
    assert.equal(backToForm(err(409, 'duplicate', { index: 1 })), true)
    assert.equal(backToForm(err(403, 'email_retired', { index: 2 })), true)
    assert.equal(backToForm(err(400, 'invalid_person', { people: { 1: { phone: 'x' } } })), true)
    assert.equal(backToForm(err(400, 'consents_required')), true)
    assert.equal(backToForm(err(400, 'consents_changed')), true)
    assert.equal(backToForm(err(409, 'full', { categoryId: '11111111-1111-4111-8111-111111111111' })), true)
    assert.equal(backToForm(err(409, 'refused')), true)
    assert.equal(backToForm(err(401, undefined)), true)
    // These stay on RA4: they are about the payment, not about a person.
    assert.equal(backToForm(err(409, 'full')), false)
    assert.equal(backToForm(err(409, 'paying_closed')), false)
    assert.equal(backToForm(err(429, 'throttled')), false)
    assert.equal(backToForm(err(502, 'dpay_unavailable')), false)
    assert.equal(backToForm(new Error('offline')), false)
  })
})

describe('G-46 RA5 consent tags', () => {
  it('the person registering, an added adult who accepted, or signed in the office → „✓ REGULAMIN”', () => {
    assert.deepEqual(consentTag({ role: 'self', consentState: 'accepted' }), { kind: 'accepted', label: '✓ REGULAMIN' })
    assert.deepEqual(consentTag({ role: 'adult', consentState: 'accepted' }), { kind: 'accepted', label: '✓ REGULAMIN' })
    assert.deepEqual(consentTag({ role: 'adult', consentState: 'office' }), { kind: 'accepted', label: '✓ REGULAMIN' })
  })

  it('a child → „✓ OPIEKUN”', () => {
    assert.deepEqual(consentTag({ role: 'minor', consentState: 'accepted' }), { kind: 'guardian', label: '✓ OPIEKUN' })
  })

  it('an added adult still awaiting → „CZEKA NA ZGODĘ” and the reminder', () => {
    const line = { role: 'adult', consentState: 'awaiting', firstName: 'Piotr' }
    assert.deepEqual(consentTag(line), { kind: 'awaiting', label: 'CZEKA NA ZGODĘ' })
    assert.equal(canRemind(line), true)
    assert.equal(remindLabel('Piotr'), 'Wyślij przypomnienie do Piotr →')
  })

  it('no reminder for anybody else, and no tag without a known state', () => {
    assert.equal(canRemind({ role: 'adult', consentState: 'accepted' }), false)
    assert.equal(canRemind({ role: 'self', consentState: 'awaiting' }), false)
    assert.equal(canRemind({ role: 'minor', consentState: 'awaiting' }), false)
    assert.equal(consentTag({ role: 'adult' }), null)
    assert.equal(consentTag({}), null)
  })
})

describe('G-46 RA5 order and tags shown', () => {
  it('the person registering first, then the added adults, then the children, each in server order', () => {
    const rows = [
      { id: 1, role: 'minor' }, { id: 2, role: 'adult' }, { id: 3, role: 'self' }, { id: 4, role: 'minor' }, { id: 5, role: 'adult' },
    ]
    assert.deepEqual(orderPeople(rows).map((r) => r.id), [3, 2, 5, 1, 4])
    assert.deepEqual(orderPeople(undefined), [])
  })

  it('a page listing only the person registering shows no tags; a group does', () => {
    assert.equal(showsConsentTags([{ role: 'self' }]), false)
    assert.equal(showsConsentTags([{ role: 'self' }, { role: 'minor' }]), true)
    assert.equal(showsConsentTags([{ role: 'adult' }]), true)
    assert.equal(showsConsentTags([]), false)
  })
})
