import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDetail } from '../src/scrapers/sources/zapisyonline.js'

// zapisyonline reads registration_deadline from the price tiers on a
// /zapisy/<id>,<slug> page, reached through the "Zapisz się" button of a
// competition row. Event 1130 (#3 RUN FOR FUN, 2026-10-17) has no such button:
// signup opens on 18.09.2026, so the row links to /zawody/2344 ("Lista
// startowa") instead. No /zapisy/ link means no price page, no tier expiry, and
// registration_deadline landed null — while the organizer had written the date
// in the description: "Rejestracja otwarta do 10/10/2026 do godz. 12:00."
// Shapes below mirror the real /wydarzenie/ pages, sampled 2026-09-16.

const page = ({ competitionBtn, description }) => `<html><body>
  <div class="competitions"><div class="events-list">
    <div class="event headers"><div class="item name">Nazwa zawodów</div></div>
    <div class="event">
      <div class="item name">#3 RUN FOR FUN</div>
      <div class="item distance">7,5 km</div>
      <div class="item kind">Zawody dla dorosłych</div>
      <div class="item btn">${competitionBtn}</div>
    </div>
  </div></div>
  <div class="contact-map location-map"><div class="content"><div class="address">
    <div class="data">Wybrzeże Szczecińskie 1 <br>03-714 Warszawa</div>
  </div></div></div>
  <div class="info article"><h2 class="title">O zawodach</h2>${description}</div>
</body></html>`

const LOCKED_BTN = '<a class="button small" href="/zawody/2344,3-run-for-fun-3-run-for-fun">Lista startowa</a>'
const OPEN_BTN = '<a class="button small" href="/zapisy/2344,3-run-for-fun">Zapisz się</a>'

const DESCRIPTION = `<p>Warunkiem uczestnictwa jest potwierdzenie udziału oraz
  rejestracja pod linkiem podanym w późniejszym terminie.</p>
  <p>Rejestracja otwarta do 10/10/2026 do godz. 12:00. Ilość miejsc ograniczona.</p>`

const registrationPage = `<html><body>
  <div class="price has">159,00 zł</div>
  <div class="msg">Powyższa cena obowiązuje do 2026-09-30</div>
</body></html>`

function stubFetch(pages) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const body = pages(String(url))
    return { ok: body !== null, text: async () => body ?? '' }
  }
  return { restore: () => { globalThis.fetch = original } }
}

test('deadline written in the description is used when signup has not opened yet', async () => {
  // The defect: no /zapisy/ button, so fetchPrices([]) runs and the deadline the
  // organizer published in plain text is never read.
  const stub = stubFetch(() => page({ competitionBtn: LOCKED_BTN, description: DESCRIPTION }))
  try {
    const detail = await fetchDetail('1130', '3-run-for-fun')
    assert.equal(detail.registrationDeadline, '2026-10-10')
    assert.equal(detail.priceFrom, null) // no price published yet, still unknown
  } finally {
    stub.restore()
  }
})

test('a real price tier expiry still wins over the description sentence', async () => {
  // The tier expiry is the live, authoritative date; the description can be stale
  // copy from an earlier edition, so it must never override it.
  const stub = stubFetch((url) =>
    url.includes('/zapisy/') ? registrationPage : page({ competitionBtn: OPEN_BTN, description: DESCRIPTION }),
  )
  try {
    const detail = await fetchDetail('1130', '3-run-for-fun')
    assert.equal(detail.registrationDeadline, '2026-09-30')
    assert.equal(detail.priceFrom, 159)
  } finally {
    stub.restore()
  }
})

test('a description with no deadline sentence leaves the field null', async () => {
  const stub = stubFetch(() =>
    page({ competitionBtn: LOCKED_BTN, description: '<p>Zapisy w dniu zawodów w biurze zawodów.</p>' }),
  )
  try {
    const detail = await fetchDetail('1130', '3-run-for-fun')
    assert.equal(detail.registrationDeadline, null)
  } finally {
    stub.restore()
  }
})

test('an impossible date in the description is not published', async () => {
  // Day-first is the Polish convention; a 13th month means the sentence was not
  // the date pattern we think it is, so emit nothing rather than a wrong day.
  const stub = stubFetch(() =>
    page({ competitionBtn: LOCKED_BTN, description: '<p>Rejestracja otwarta do 10/13/2026.</p>' }),
  )
  try {
    const detail = await fetchDetail('1130', '3-run-for-fun')
    assert.equal(detail.registrationDeadline, null)
  } finally {
    stub.restore()
  }
})
