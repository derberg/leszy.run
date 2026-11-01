import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wizardSteps, stepForBlocking } from '../../src/lib/wizardSteps.js'

const ALL = ['Podstawy', 'Biuro zawodów', 'Konkurencje', 'Kategorie', 'Pomiar czasu', 'Formularz', 'Dodatki', 'Płatności', 'Publikacja']
const empty = { blocking: [], missing: [] }

test('a paid event has the nine steps in spec order', () => {
  const steps = wizardSteps({ pricingMode: 'fixed', hasKidsCompetition: false, state: { checklist: empty } })
  assert.deepEqual(steps.map((s) => s.label), ALL)
  assert.deepEqual(steps.map((s) => s.key),
    ['podstawy', 'biuro', 'konkurencje', 'kategorie', 'pomiar', 'formularz', 'dodatki', 'platnosci', 'publikacja'])
})

test('a free event has no Płatności step', () => {
  for (const pricingMode of ['free', undefined, null]) {
    const steps = wizardSteps({ pricingMode, hasKidsCompetition: false, state: { checklist: empty } })
    assert.deepEqual(steps.map((s) => s.label), ALL.filter((l) => l !== 'Płatności'))
  }
})

test('every step is available, Dodatki included (Plan 7)', () => {
  const steps = wizardSteps({ pricingMode: 'fixed', hasKidsCompetition: true, state: { checklist: empty } })
  for (const s of steps) assert.equal(s.available, true, s.key)
})

test('V-20 a free event shows Płatności when it has a priced extra or takes donations (D7-22)', () => {
  const labels = (over) => wizardSteps({ pricingMode: 'free', hasKidsCompetition: false, state: { checklist: empty }, ...over }).map((s) => s.label)
  assert.deepEqual(labels({ hasPricedExtras: true }), ALL)
  assert.deepEqual(labels({ donationsEnabled: true }), ALL)
  assert.deepEqual(labels({ hasPricedExtras: false, donationsEnabled: false }), ALL.filter((l) => l !== 'Płatności'))
})

test('Kategorie offers kids groups only when a kids competition exists', () => {
  const kat = (hasKidsCompetition) => wizardSteps({ pricingMode: 'free', hasKidsCompetition, state: { checklist: empty } })
    .find((s) => s.key === 'kategorie')
  assert.equal(kat(true).kidsGroups, true)
  assert.equal(kat(false).kidsGroups, false)
})

test('a step behind the current one is done unless the checklist blocks on it', () => {
  const checklist = {
    blocking: [{ key: 'competitions', label: 'Co najmniej jedna konkurencja' }, { key: 'agreement', label: 'Umowa' }],
    missing: [{ key: 'office_hours', label: 'Godziny', step: 'biuro' }],
  }
  const steps = wizardSteps({ pricingMode: 'free', hasKidsCompetition: false, state: { checklist, current: 'formularz' } })
  const done = Object.fromEntries(steps.map((s) => [s.key, s.done]))
  assert.deepEqual(done, {
    podstawy: true, biuro: false, konkurencje: false, kategorie: true, pomiar: true,
    formularz: false, dodatki: false, publikacja: false,
  })
})

test('nothing ahead of the current step is done, even when it has no gaps', () => {
  const steps = wizardSteps({ pricingMode: 'free', hasKidsCompetition: false, state: { checklist: empty, current: 'podstawy' } })
  assert.ok(steps.every((s) => !s.done))
})

test('a blocking item about the basics keeps Podstawy open', () => {
  for (const key of ['name', 'slug', 'event_date', 'registration_dates', 'place', 'regulamin']) {
    const steps = wizardSteps({
      pricingMode: 'free', hasKidsCompetition: false,
      state: { checklist: { blocking: [{ key, label: key }], missing: [] }, current: 'biuro' },
    })
    assert.equal(steps[0].done, false, key)
  }
})

test('blocking items map to the step that fixes them', () => {
  assert.equal(stepForBlocking('event_date'), 'podstawy')
  assert.equal(stepForBlocking('contact_email'), 'podstawy')
  assert.equal(stepForBlocking('competition:6b8c…'), 'konkurencje')
  assert.equal(stepForBlocking('payments'), 'platnosci')
  assert.equal(stepForBlocking('payout'), 'platnosci')
  assert.equal(stepForBlocking('agreement'), 'publikacja')
  assert.equal(stepForBlocking('tiers'), 'konkurencje')
  assert.equal(stepForBlocking('transfer_until'), 'platnosci')
  assert.equal(stepForBlocking('extras_order_until'), 'dodatki')
})
