import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDetailPage } from '../src/scrapers/sources/timekeeper.js'

// timekeeper never read a price at all. The "Koszt uczestnictwa" card was located by
// $('h5, h6, strong'), but the heading is <h4 class="m-0">, so the card was never found,
// and the handler inside it only ever read the distance h6 — the fee sits in the
// .text-right cell next to it and nothing looked there.
//
// X Krotoszyński Bieg Niepodległości (2026-11-11, timekeeper:x-krotoszynski-bieg-niepodleglosci)
// published with price_from and price_to null and distances null, from a card that states
// 1918m / Bezpłatnie. 18 timekeeper rows carry no price.
//
// Markup below is copied from the live pages, sampled 2026-10-01.

const page = cards => `<html><body>
<div class="container pb-4"><div class="row"><div class="pb-4 col md:pb-0"><div class="container">
  <div class="row">
    <div class="col border-right">
      <h5 class="text-uppercase text-secondary font-weight-bolder">Data zawodów</h5>
      <p class="text-primary h3 d-none d-lg-block">2026-11-11</p>
      <p class="text-primary h3 d-block d-lg-none">2026-11-11</p>
    </div>
    <div class="col">
      <h5 class="text-uppercase text-secondary font-weight-bolder">Lokalizacja</h5>
      <p class="text-primary h3 d-none d-lg-block">Krotoszyn</p>
      <p class="text-primary h3 d-block d-lg-none">Krotoszyn</p>
    </div>
  </div>
</div></div></div></div>
${cards}
</body></html>`

const costCard = rows => `<div class="card w-100 ">
  <div class="card-header">
    <div class="container p-0"><div class="row no-gutters"><div class="col">
      <h4 class="m-0">Koszt uczestnictwa</h4>
    </div></div></div>
  </div>
  <div class="card-body">${rows}</div>
</div>`

const row = (distance, priceCell) => `<div class="row no-gutters align-items-center">
  <div class="col-8 d-flex align-self-center">
    <h6 class="font-weight-bolder m-0">${distance}</h6>
  </div>
  <div class="text-right col">${priceCell}</div>
</div>`

test('a free race reports 0, not unknown', () => {
  // The row that broke. "Bezpłatnie" is the fee, and 0 is a value.
  const got = parseDetailPage(page(costCard(
    row('1918m', '<h6 class="text-right text-danger font-weight-bolder ">Bezpłatnie</h6>'),
  )))
  assert.equal(got.priceFrom, 0)
  assert.equal(got.priceTo, 0)
  assert.equal(got.distances, '1918m')
})

test('a paid race with several starts reports the cheapest and the dearest', () => {
  // XIX Półmaraton Ełcki i IV Ełcka Piątka: 90.00 zł and 40.00 zł.
  const got = parseDetailPage(page(costCard(
    row('Połmaraton (gwarancja właściwego rozmiaru koszulki do 15 września)',
      '<h6 class="text-right text-secondary font-weight-bolder ">\n 90.00\n zł</h6>') +
    '<hr>' +
    row('Piątka (bez koszulki)',
      '<h6 class="text-right text-secondary font-weight-bolder ">\n 40.00\n zł</h6>'),
  )))
  assert.equal(got.priceFrom, 40)
  assert.equal(got.priceTo, 90)
})

test('a promotional price ignores the struck-out old fee', () => {
  // Bieg Mikołajowy prints <del>80.00 zł</del> beside the 70.00 zł actually charged.
  // Reading both would publish a 80 zł price_to nobody pays.
  const got = parseDetailPage(page(costCard(
    row('Bieg 10km', `<div>
      <h6 class="text-muted d-inline"><del>80.00 zł</del></h6>
      <h6 class="text-right font-weight-bolder text-danger d-inline">70.00 zł</h6>
    </div>`),
  )))
  assert.equal(got.priceFrom, 70)
  assert.equal(got.priceTo, 70)
})

test('a free start beside a paid one does not make the race free', () => {
  // price_from 0 says "this race costs nothing". A free kids run must not say that
  // on behalf of a half marathon that charges 90 zł.
  const got = parseDetailPage(page(costCard(
    row('Bieg dzieci 300m', '<h6 class="text-right text-danger font-weight-bolder ">Bezpłatnie</h6>') +
    '<hr>' +
    row('Półmaraton', '<h6 class="text-right text-secondary font-weight-bolder ">90.00 zł</h6>'),
  )))
  assert.equal(got.priceFrom, 90)
  assert.equal(got.priceTo, 90)
})

test('a page with no cost card leaves the price unknown', () => {
  // No card means no statement about the fee. Null, never 0.
  const got = parseDetailPage(page(''))
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
  assert.equal(got.distances, '')
})

test('a cost card with an unreadable fee leaves the price unknown but keeps the distance', () => {
  const got = parseDetailPage(page(costCard(
    row('10 km', '<h6 class="text-right text-secondary font-weight-bolder ">wg regulaminu</h6>'),
  )))
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
  assert.equal(got.distances, '10 km')
})

test('the date and location cards still parse', () => {
  // The cost card fix must not disturb the headings that were already working.
  const got = parseDetailPage(page(costCard(
    row('1918m', '<h6 class="text-right text-danger font-weight-bolder ">Bezpłatnie</h6>'),
  )))
  assert.equal(got.date, '2026-11-11')
  assert.equal(got.location, 'Krotoszyn')
})
