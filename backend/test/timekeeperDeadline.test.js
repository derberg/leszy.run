import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseDetailPage } from '../src/scrapers/sources/timekeeper.js'

// timekeeper never read a registration deadline. The detail page states none as a
// date: it shows a countdown, "Do końca zapisów on-line pozostało 107 dni", and the
// only absolute dates on it are price-tier cutoffs, which are not the deadline.
//
// BIEG TROPEM WILCZYM - Bilcza (2027-03-07, timekeeper:bieg-tropem-wilczym-bilcza)
// published with no registration_deadline. The block below is copied verbatim from
// https://competitions.timekeeper.pl/bieg-tropem-wilczym-bilcza, fetched 2026-11-18.

const COUNTDOWN = `
                                <div class="row">
                    <div class="mt-3 text-center col text-secondary"
                        style="font-family: 'Oxanium', cursive; font-size: 18px; letter-spacing: 3px;">
                        Do końca zapisów on-line pozostało
                        107
                        dni
                    </div>
                </div>`

const HEADER = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/timekeeper-date-location.html', import.meta.url)), 'utf8')

const page = (...parts) => `<html><body>${parts.join('\n')}</body></html>`

// 2026-11-18 in Warsaw, late enough in the UTC day to catch a UTC/Warsaw mix-up.
const FETCHED = new Date('2026-11-18T22:30:00Z') // 2026-11-18 23:30 in Warsaw

test('the countdown becomes a deadline counted from the fetch day in Warsaw', () => {
  const got = parseDetailPage(page(COUNTDOWN), FETCHED)
  assert.equal(got.registrationDeadline, '2027-03-05')
})

test('the Warsaw day is used, not the UTC day', () => {
  // 2026-11-18 23:30 UTC is already 2026-11-19 in Warsaw.
  const got = parseDetailPage(page(COUNTDOWN), new Date('2026-11-18T23:30:00Z'))
  assert.equal(got.registrationDeadline, '2027-03-06')
})

test('the header fixture, fetched 2026-10-01, reads 39 days to 2026-11-09', () => {
  // x-krotoszynski-bieg-niepodleglosci, race on 2026-11-11.
  const got = parseDetailPage(page(HEADER), new Date('2026-10-01T10:00:00Z'))
  assert.equal(got.date, '2026-11-11')
  assert.equal(got.registrationDeadline, '2026-11-09')
})

test('a deadline past the race day is clamped to the race day', () => {
  // 39 days from 2026-10-20 is 2026-11-28, after the 2026-11-11 race.
  const got = parseDetailPage(page(HEADER), new Date('2026-10-20T10:00:00Z'))
  assert.equal(got.registrationDeadline, '2026-11-11')
})

test('no countdown, no deadline', () => {
  const got = parseDetailPage(page('<p class="text-primary h3">2026-11-11</p>'), FETCHED)
  assert.equal(got.registrationDeadline, null)
})

test('the phrase outside the countdown div is not a deadline', () => {
  // e.g. an organizer's description quoting last edition's countdown.
  const got = parseDetailPage(page('<p>Do końca zapisów on-line pozostało 12 dni</p>'), FETCHED)
  assert.equal(got.registrationDeadline, null)
})

test('mapRow does not store registration_deadline until scraper_timekeeper has the column', async () => {
  // Pins the gap the countdown fix leaves open: the value stops at mapRow, so nothing
  // reaches scraper_all or the published page. Flip this test together with the
  // ALTER TABLE and the mapRow line documented in index.js.
  const { sources } = await import('../src/scrapers/index.js')
  const timekeeper = sources.find((s) => s.name === 'timekeeper')
  const row = timekeeper.mapRow({ name: 'x', date: '2027-03-07', source_id: 'x', registration_deadline: '2027-03-05' })
  assert.equal('registration_deadline' in row, false)
})
