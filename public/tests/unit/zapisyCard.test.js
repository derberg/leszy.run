import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardLinks, linksInHeader } from '../../src/lib/zapisyCard.js'

const ev = (over) => ({ slug: 'bieg', orders: [], people: [], ...over })

test('one order and a confirmed entry: „Zamówienie” then „Twój zapis”, plain labels, the same hrefs', () => {
  const links = cardLinks(ev({ orders: [{ id: 'o1', total: 4000 }], people: [{ status: 'confirmed' }] }))
  assert.deepEqual(links.map((l) => [l.label, l.to]), [['Zamówienie', '/zamowienie/o1'], ['Twój zapis', '/events/bieg/zapisano']])
})

test('no order: no „Zamówienie”; an unpaid entry only: no „Twój zapis”', () => {
  assert.deepEqual(cardLinks(ev({ people: [{ status: 'confirmed' }] })).map((l) => l.label), ['Twój zapis'])
  assert.deepEqual(cardLinks(ev({ orders: [{ id: 'o1', total: 6000 }], people: [{ status: 'pending_payment' }] })).map((l) => l.label), ['Zamówienie'])
  assert.deepEqual(cardLinks(ev({})), [])
})

test('several orders carry their totals; several confirmed entries read „Twoje zapisy”', () => {
  const links = cardLinks(ev({ orders: [{ id: 'a', total: 4000 }, { id: 'b', total: 2000 }], people: [{ status: 'confirmed' }, { status: 'confirmed' }] }))
  assert.deepEqual(links.map((l) => l.label), ['Zamówienie · 40,00 zł', 'Zamówienie · 20,00 zł', 'Twoje zapisy'])
})

test('labels carry no arrow', () => {
  const links = cardLinks(ev({ orders: [{ id: 'o1', total: 1 }], people: [{ status: 'confirmed' }] }))
  for (const l of links) assert.doesNotMatch(l.label, /→/)
})

test('the links go in a header menu only on a card with no person line', () => {
  assert.equal(linksInHeader(ev({ people: [] })), true)
  assert.equal(linksInHeader(ev({ people: [{}] })), false)
  assert.equal(linksInHeader(ev({ people: [{}, {}] })), false)
})
