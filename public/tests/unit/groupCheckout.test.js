import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { backToForm, checkoutModel, repricedByCategory, repriceLines } from '../../src/lib/checkout.js'
import { canRemind, consentTag, orderPeople, personGroupLabel, remindAriaLabel, remindError, remindLabel, showsConsentTags } from '../../src/lib/consentTag.js'

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
    const m = checkoutModel({ entryPrices: lines.map((l) => l.priceGrosze) })
    assert.equal(m.amounts.entryTotal, 14000)
    assert.equal(m.totalLabel, '140,00 zł')
    assert.equal(m.payDisabled, false)
  })

  it('price_changed with each person\'s new price re-prices every line, in order', () => {
    const next = repriceLines(lines, { entryTotal: 15000, entryPrices: [6500, 6500, 2000], total: 15000 })
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
    assert.equal(repriceLines(lines, { total: 15000 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 15000, total: 15000 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 15000, entryPrices: [6500, 6500], total: 15000 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 99, entryPrices: [6500, 6500, 2000], total: 15000 }), null)
    assert.equal(repriceLines(lines, { entryTotal: 15000, entryPrices: [6500, '6500', 2000], total: 15000 }), null)
    assert.equal(repriceLines(lines, null), null)
  })

  it('back to the form: a person\'s refusal, a full competition the server names, the generic group refusal, no session', () => {
    const err = (status, code, extra = {}) => Object.assign(new Error('x'), { status, code, ...extra })
    assert.equal(backToForm(err(409, 'duplicate', { index: 1 })), true)
    assert.equal(backToForm(err(403, 'email_retired', { index: 2 })), true)
    assert.equal(backToForm(err(400, 'invalid_person', { people: { 1: { phone: 'x' } } })), true)
    assert.equal(backToForm(err(400, 'consents_required')), true)
    assert.equal(backToForm(err(400, 'consents_changed')), true)
    assert.equal(backToForm(err(409, 'full', { categoryId: '11111111-1111-4111-8111-111111111111' }), ['11111111-1111-4111-8111-111111111111']), true)
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
    assert.deepEqual(consentTag({ role: 'self', consentState: 'accepted' }), { kind: 'accepted', label: '✓ REGULAMIN', srLabel: 'regulamin zaakceptowany' })
    assert.deepEqual(consentTag({ role: 'adult', consentState: 'accepted' }), { kind: 'accepted', label: '✓ REGULAMIN', srLabel: 'regulamin zaakceptowany' })
    assert.deepEqual(consentTag({ role: 'adult', consentState: 'office' }), { kind: 'accepted', label: '✓ REGULAMIN', srLabel: 'regulamin zaakceptowany' })
  })

  it('a child → „✓ OPIEKUN”', () => {
    assert.deepEqual(consentTag({ role: 'minor', consentState: 'accepted' }), { kind: 'guardian', label: '✓ OPIEKUN', srLabel: 'zgoda opiekuna' })
  })

  it('an added adult still awaiting → „CZEKA NA ZGODĘ” and the reminder', () => {
    const line = { role: 'adult', consentState: 'awaiting', firstName: 'Piotr' }
    assert.deepEqual(consentTag(line), { kind: 'awaiting', label: 'CZEKA NA ZGODĘ', srLabel: 'czeka na zgodę na regulamin' })
    assert.equal(canRemind(line), true)
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

const CAT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const refusal = (status, code, extra = {}) => Object.assign(new Error('Brak wolnych miejsc w konkurencji X.'), { status, code, ...extra })

describe('G-46 fix round 1: RA4', () => {
  it('I-1: `full` goes back to the form only when an added card is in that competition', () => {
    assert.equal(backToForm(refusal(409, 'full', { categoryId: CAT }), [CAT]), true)
    assert.equal(backToForm(refusal(409, 'full', { categoryId: CAT.toUpperCase() }), [CAT]), true)
    // a single runner, or a group whose full competition holds only card 1: Plan 3's RA4 message
    assert.equal(backToForm(refusal(409, 'full', { categoryId: CAT }), []), false)
    assert.equal(backToForm(refusal(409, 'full', { categoryId: CAT }), [OTHER]), false)
    assert.equal(backToForm(refusal(409, 'full', { categoryId: CAT })), false)
    // a person's refusal still goes back without the list
    assert.equal(backToForm(refusal(409, 'duplicate', { index: 0 })), true)
  })

  it('N-2: a negative price never re-prices a line', () => {
    const one = [{ key: 'a', categoryId: CAT, priceGrosze: 6000 }]
    assert.equal(repriceLines(one, { entryPrices: [-1], entryTotal: -1 }), null)
    assert.equal(repriceLines(one, { entryTotal: -6000 }), null)
  })

  it('N-3: the re-priced lines as a price per competition, for the form to keep', () => {
    const lines = [
      { key: 'a', categoryId: CAT, priceGrosze: 6500 }, { key: 'b', categoryId: CAT, priceGrosze: 6500 },
      { key: 'c', categoryId: OTHER, priceGrosze: 2000 },
    ]
    assert.deepEqual(repricedByCategory(lines), { [CAT]: 6500, [OTHER]: 2000 })
  })
})

describe('G-46 fix round 1: RA5', () => {
  it('the reminder reads „Wyślij przypomnienie →”, its accessible name carries the person', () => {
    assert.equal(remindLabel(), 'Wyślij przypomnienie →')
    assert.equal(remindAriaLabel('Piotr Leśny'), 'Wyślij przypomnienie do: Piotr Leśny')
  })

  it('M-1: every reminder refusal reads in Polish', () => {
    const e = (status, message, code) => Object.assign(new Error(message), { status, code })
    assert.equal(remindError(new Error('offline')), 'Nie udało się połączyć. Spróbuj ponownie.')
    assert.equal(remindError(e(401, 'Authorization required')), 'Zaloguj się ponownie, żeby wysłać przypomnienie.')
    assert.equal(remindError(e(500, 'Internal server error')), 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.')
    assert.equal(remindError(e(502, 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.', 'email_failed')),
      'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.')
    assert.equal(remindError(e(429, 'Przypomnienie zostało już wysłane. Spróbuj jutro.', 'throttled')), 'Przypomnienie zostało już wysłane. Spróbuj jutro.')
    assert.equal(remindError(e(409, 'To zgłoszenie nie czeka na akceptację regulaminu.', 'not_awaiting')), 'To zgłoszenie nie czeka na akceptację regulaminu.')
    assert.equal(remindError(e(404, 'Not found')), 'Nie znaleźliśmy tego zgłoszenia.')
  })

  it('N-5: each tag has a spoken meaning', () => {
    assert.equal(consentTag({ role: 'self', consentState: 'accepted' }).srLabel, 'regulamin zaakceptowany')
    assert.equal(consentTag({ role: 'minor', consentState: 'accepted' }).srLabel, 'zgoda opiekuna')
    assert.equal(consentTag({ role: 'adult', consentState: 'awaiting' }).srLabel, 'czeka na zgodę na regulamin')
  })

  it('N-4 (ruled): the payer\'s own row keeps its tag (RB4); only an added adult whose list holds just their own row sees none', () => {
    assert.equal(consentTag({ role: 'self', consentState: 'accepted', mine: true }).label, '✓ REGULAMIN')
    assert.equal(showsConsentTags([{ role: 'adult', consentState: 'accepted', mine: true }]), false)
    assert.equal(showsConsentTags([{ role: 'self', mine: true }, { role: 'adult', mine: false }]), true)
  })

  it('ruling: the kids\' group label wins over the age class', () => {
    assert.equal(personGroupLabel({ kidsGroupLabel: 'Dzieci 2015–2017', ageGroupLabel: 'K open' }), 'Dzieci 2015–2017')
    assert.equal(personGroupLabel({ kidsGroupLabel: null, ageGroupLabel: 'K open' }), 'K open')
    assert.equal(personGroupLabel({}), null)
  })
})
