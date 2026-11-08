import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrape, CATEGORY_URLS } from '../src/scrapers/sources/elektronicznezapisy.js'

// The scraper read only two of the portal's discipline listings, /1/bieg.html and
// /2/nordic-walking.html. An organizer picks the disciplines, and a running event
// filed only under another running discipline never reached us. Measured on the
// portal archive for 2026-05-09..11: 8 running events had no elektronicznezapisy
// link in scraper_all, all listed outside disciplines 1 and 2 — 15086 Ultramaraton
// Warmiński (52 ULTRA), 15088/15090/15099 (48 bieg przełajowy), 15097 Festiwal
// Górski (62 bieg górski), 15003 Olkuski Test Coopera (71 bieg na czas), 15289 Eko
// Bieg Mamutka (19 biegi dla dzieci). On 2026-11-08 the live listings held 15779
// (7. Nocny Maraton w Lesie Łagiewnickim, 48 only) and four Bieg Niepodległości
// races (57 only), none of them in scraper_elektronicznezapisy.

const categoryIds = () => CATEGORY_URLS.map(c => Number(c.url.match(/\.pl\/(\d+)\//)[1]))

test('every running discipline listing is read', () => {
  const ids = categoryIds()
  for (const id of [1, 2, 14, 19, 23, 28, 32, 48, 52, 57, 62, 64, 65, 71]) {
    assert.ok(ids.includes(id), `discipline ${id} must be scraped`)
  }
})

test('disciplines that are not a running or NW event stay out', () => {
  // inne (11) holds strength training and sauna evenings; kolarstwo (15),
  // pływanie (16), triathlon (4) and bieg na orientację (7) are other sports.
  const ids = categoryIds()
  for (const id of [4, 7, 11, 15, 16]) {
    assert.equal(ids.includes(id), false, `discipline ${id} must not be scraped`)
  }
})

const row = (id, name, date) => `<tr class="even">
  <td>8.</td>
  <td><a href="event/${id}/strona.html">${name}</a><span class="hidden-sm"> - ${date} 15:00</span></td>
  <td class="hidden-xs text-nowrap">${date} 15:00</td>
  <td class="text-nowrap hidden-xs"><a href="event/${id}/clients.html">lista uczestników</a></td>
  <td class="hidden-xs"><span class="badge">81</span></td>
  <td><a href="event/${id}/signup.html" class="btn btn-primary btn-xs">Zapisz się</a></td>
</tr>`

const detail = (name) => `<html><body><h1>${name}</h1><ul class="list-group">
  <li class="list-group-item">Początek imprezy: <strong>2027.01.23 15:00</strong></li>
</ul></body></html>`

test('an event listed only under bieg przełajowy is scraped', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    let body = ''
    if (u.includes('.pl/48/')) {
      body = `<table>${row('15779', 'Las Łagiewnicki, "7. Nocny Maraton"', '2027-01-23')}</table>`
    } else if (u.includes('/15779/strona')) {
      body = detail('7. Nocny Maraton/Półmaraton z Ultra Teamem w Lesie Łagiewnickim')
    }
    return { ok: true, text: async () => body }
  }
  try {
    const events = await scrape({ today: '2026-11-08', pauseMs: 0 })
    const found = events.find(e => e.source_id === '15779')
    assert.ok(found, '15779 must be emitted')
    assert.equal(found.date, '2027-01-23')
    assert.equal(found.registration_url, 'https://elektronicznezapisy.pl/event/15779/signup.html')
  } finally {
    globalThis.fetch = original
  }
})
