import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrape } from '../src/scrapers/sources/inessport.js'
import { sources, changedKnownFields } from '../src/scrapers/index.js'

// inesSport lists a race before it opens sign-ups. Group gr333 (XV OGÓLNOPOLSKI
// BIEG BARBÓRKOWY SOLIDARNOŚCI, 2026-11-29) read, on 2026-10-12, "Zapisy od
// 2026-10-26 00:00:00" where the "Formularz zgłoszenia" button sits on an open
// race, so the scraper stored registration_url = null. The form itself already
// exists at act=zgloszenie-zawodnika&event=1515: it returns 200, carries the race
// name and reads "Wydarzenie nieaktywne" until the opening date.
//
// ev1492 (III Bieg Napoleona, 2026-10-18) is the case that must NOT get a link:
// no form button and no "Zapisy od" date, and its form is inactive too — sign-ups
// there are over or offline, so a link would send runners to a dead form.
// Shapes below mirror the real listing, sampled 2026-10-12, with the race year
// moved to 2099 because the scraper drops races already run.

const FORM = (id) => `https://zapisy.inessport.pl/index.php?idm=5&idp=0&act=zgloszenie-zawodnika&event=${id}`

const groupBeforeOpening = `
<a class="anchor" id="gr333"  >gr333</a><div class="event-item-main"><div class="event-date"><span class="day">29</span><span class="month">Listopad</span><span class="year">2099</span></div><div class="event-header"><h1 class="event-title">XV OGÓLNOPOLSKI BIEG BARBÓRKOWY SOLIDARNOŚCI</h1>Bogdanka</div><div class="event-content"><p></p>
</div><a class="anchor" id="ev1515"  >ev1515</a><div class="event-subitem-main"><div class="event-header"><h1 class="event-title">XV OGÓLNOPOLSKI BIEG BARBÓRKOWY SOLIDARNOŚCI</h1>2026-11-29<br>Bogdanka</div><a href="/index.php?idm=5&idp=0&act=lista-startowa&event=1515" class="btn btn-blue">Lista startowa</a>&nbsp;Zapisy od 2026-10-26 00:00:00&nbsp;<a href="https://drive.google.com/file/d/1VqlQ5BoDHPnGiMWVJPwLnujw7IiMcV8J/view?usp=drive_link" class="btn btn-red" target="_blank">Regulamin</a>&nbsp;</div><a class="anchor" id="ev1516"  >ev1516</a><div class="event-subitem-main"><div class="event-header"><h1 class="event-title">II Ogólnopolskie Biegi Barbórkowe dla dzieci i młodzieży</h1>2026-11-29<br>Bogdanka</div><a href="/index.php?idm=5&idp=0&act=lista-startowa&event=1516" class="btn btn-blue">Lista startowa</a>&nbsp;Zapisy od 2026-10-26 00:00:00&nbsp;<a href="https://drive.google.com/file/d/1vXCuD5DDObdrvKRI3_fg9bj580D1iYM5/view?usp=drive_link" class="btn btn-red" target="_blank">Regulamin</a>&nbsp;</div></div>`

const standaloneBeforeOpening = `
<a class="anchor" id="ev1600"  >ev1600</a><div class="event-item-main"><div class="event-date"><span class="day">6</span><span class="month">Grudzień</span><span class="year">2099</span></div><div class="event-name"><h1 class="event-h1">Bieg Mikołajkowy</h1>Łódź</div><div class="event-content"><p></p>
</div><a href="/index.php?idm=5&idp=0&act=lista-startowa&event=1600" class="btn btn-blue">Lista startowa</a>&nbsp;Zapisy od 2026-11-01 00:00:00&nbsp;</div>`

const standaloneClosed = `
<a class="anchor" id="ev1492"  >ev1492</a><div class="event-item-main"><div class="event-date"><span class="day">18</span><span class="month">Październik</span><span class="year">2099</span></div><div class="event-name"><h1 class="event-h1">III Bieg Napoleona</h1>Rodrysin</div><div class="event-content"><p></p>
</div><a href="/index.php?idm=5&idp=0&act=lista-startowa&event=1492" class="btn btn-blue">Lista startowa</a>&nbsp;<a href="https://docs.google.com/document/d/1NS6nHIKu6JMkTwUgRQcK7dwZ0jnwf4bA/edit" class="btn btn-red" target="_blank">Regulamin</a>&nbsp;</div>`

// gr327 on 2026-10-12: the adult race's form had closed, the kids race's was open.
const groupAdultClosed = `
<a class="anchor" id="gr327"  >gr327</a><div class="event-item-main"><div class="event-date"><span class="day">18</span><span class="month">Październik</span><span class="year">2099</span></div><div class="event-header"><h1 class="event-title">7. Radzymiński Trail</h1>Radzymin</div><div class="event-content"><p></p>
</div><a class="anchor" id="ev1489"  >ev1489</a><div class="event-subitem-main"><div class="event-header"><h1 class="event-title">7. Radzymiński Trail</h1>2099-10-18<br>Radzymin</div><a href="/index.php?idm=5&idp=0&act=lista-startowa&event=1489" class="btn btn-blue">Lista startowa</a>&nbsp;</div><a class="anchor" id="ev1490"  >ev1490</a><div class="event-subitem-main"><div class="event-header"><h1 class="event-title">7. Radzymiński Trail - biegi dziecięce</h1>2099-10-18<br>Radzymin</div><a href="/index.php?idm=5&idp=0&act=lista-startowa&event=1490" class="btn btn-blue">Lista startowa</a>&nbsp;<a href="/index.php?idm=5&idp=0&act=zgloszenie-zawodnika&event=1490" class="btn btn-blue">Formularz zgłoszenia</a>&nbsp;</div></div>`

const groupKidsOnly = `
<a class="anchor" id="gr400"  >gr400</a><div class="event-item-main"><div class="event-date"><span class="day">1</span><span class="month">Czerwiec</span><span class="year">2099</span></div><div class="event-header"><h1 class="event-title">Biegi dla dzieci</h1>Łódź</div><div class="event-content"><p></p>
</div><a class="anchor" id="ev1700"  >ev1700</a><div class="event-subitem-main"><div class="event-header"><h1 class="event-title">Biegi dla dzieci - przedszkolaki</h1>2099-06-01<br>Łódź</div><a href="/index.php?idm=5&idp=0&act=zgloszenie-zawodnika&event=1700" class="btn btn-blue">Formularz zgłoszenia</a>&nbsp;</div></div>`

const listing = `<html><body><div class="event-list">${groupBeforeOpening}${standaloneBeforeOpening}${standaloneClosed}${groupAdultClosed}${groupKidsOnly}</div></body></html>`

async function scrapeListing(html) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => html })
  try {
    return await scrape()
  } finally {
    globalThis.fetch = original
  }
}

test('a group race listed with "Zapisy od" links the adult race form before it opens', async () => {
  const rows = await scrapeListing(listing)
  const row = rows.find((r) => r.source_id === 'gr333')
  assert.equal(row.registration_url, FORM(1515))
})

test('a standalone race listed with "Zapisy od" links its own form', async () => {
  const rows = await scrapeListing(listing)
  const row = rows.find((r) => r.source_id === 'ev1600')
  assert.equal(row.registration_url, FORM(1600))
})

test('a race with no form button and no opening date gets no link', async () => {
  const rows = await scrapeListing(listing)
  const row = rows.find((r) => r.source_id === 'ev1492')
  assert.equal(row.registration_url, null)
})

test('a group whose adult form has closed does not borrow the kids form', async () => {
  const rows = await scrapeListing(listing)
  assert.equal(rows.find((r) => r.source_id === 'gr327').registration_url, null)
})

test('a kids-only group still links its kids form', async () => {
  const rows = await scrapeListing(listing)
  assert.equal(rows.find((r) => r.source_id === 'gr400').registration_url, FORM(1700))
})

test('a stored row that gains a registration_url is queued for re-merge', () => {
  // Without knownColumns the pipeline keeps merged_at on every known row, so a
  // link the scraper finds later lands in scraper_inessport and stops there.
  const { knownColumns } = sources.find((s) => s.name === 'inessport')
  const stored = { source_id: 'gr333', date: '2099-11-29', registration_url: null }
  const fresh = { ...stored, registration_url: FORM(1515) }
  assert.deepEqual(changedKnownFields(fresh, stored, knownColumns), ['registration_url'])
})
