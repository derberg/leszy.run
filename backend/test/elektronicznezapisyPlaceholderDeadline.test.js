import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDetailPage } from '../src/scrapers/sources/elektronicznezapisy.js'

// An elektronicznezapisy "zapisy niebawem" placeholder (the organizer created the
// event, registration not configured yet) shows the creation timestamp as both
// "Otwarcie rejestracji" and "Zamknięcie rejestracji". Event 15282 (Goń Zajączka
// III Bieg Charytatywny, 2027-04-10) read 2026.04.13 09:40 for both on
// 2026-11-11, with an empty Cennik, and the scraper stored 2026-04-13 as the
// deadline, 362 days before the race. List items copied from that page.

function page({ opening, closing }) {
  return `<html><body><h1>Goń Zajączka III Bieg Charytatywny</h1>
<ul class="list-group">
  <li class="list-group-item list-group-item-info">Informacje ogólne</li>
  <li class="list-group-item">Miejsce: <strong>Gdańsk</strong></li>
  <li class="list-group-item">Początek imprezy: <strong>2027.04.10 10:30</strong></li>
  <li class="list-group-item">Otwarcie rejestracji: <strong>${opening}</strong></li>
  <li class="list-group-item">Zamknięcie rejestracji: <strong>${closing}</strong></li>
</ul>
<ul class="list-group"><li class="list-group-item list-group-item-info">Cennik</li></ul>
</body></html>`
}

async function detailFor(html) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => html })
  try {
    return await fetchDetailPage('15282')
  } finally {
    globalThis.fetch = original
  }
}

test('a placeholder whose closing equals its opening has no deadline', async () => {
  const detail = await detailFor(page({ opening: '2026.04.13 09:40', closing: '2026.04.13 09:40' }))
  assert.equal(detail.date, '2027-04-10')
  assert.equal(detail.registration_deadline, null)
  assert.equal(detail.price_from, null)
  assert.equal(detail.price_to, null)
})

test('a configured registration keeps its closing date', async () => {
  const detail = await detailFor(page({ opening: '2026.11.01 08:00', closing: '2027.04.08 23:59' }))
  assert.equal(detail.registration_deadline, '2027-04-08')
})

test('closing on the opening day at a later time is still a deadline', async () => {
  const detail = await detailFor(page({ opening: '2027.04.08 08:00', closing: '2027.04.08 23:59' }))
  assert.equal(detail.registration_deadline, '2027-04-08')
})
