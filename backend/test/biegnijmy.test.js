import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseListing } from '../src/scrapers/sources/biegnijmy.js'

// One row of index.php?plik=imprezy&co=2026-, as served on 2026-10-11.
const ROW = `<table><tr class='bieg'><td class='data'>paź<br><b>11</b></td><td class='szczegoly'><table>
<tr style='height: 35px;'><td class='czarny' colspan='2'><a href=/nordic-walking-wokol-jeziora-bukowiec-swidwin-2026><b>Nordic Walking wokół jeziora Bukowiec (jez. Bukowiec)<br></b></a></td></tr>
<tr><td colspan='2'>2026-10-11, Świdwin</td></tr>
<tr><td style='width:50px'>Dystans:</td><td>3,2 km (marsz NW)</td></tr>
<tr><td style='width:50px'>Organizator:</td><td>Miejski Ośrodek Sportu i Rekreacji w Świdwinie</td></tr>
<tr><td colspan='3'><br><a class='naglowekbiegu' href='https://biegnijmy.pl/artykuly/zapisy/20261011-2-swidwin/Regulamin%20nording-walking%202026.pdf' target=_blank rel='nofollow'>REGULAMIN</a><a class='naglowekbiegu' href='https://biegnijmy.pl/index.php?kat=zapisy/20261011-2-swidwin&plik=zapisy' target=_blank rel='nofollow'>ZAPISY</a><a class='naglowekbiegu' href='https://biegnijmy.pl/index.php?kat=zapisy/20261011-2-swidwin&plik=lista-startowa' target=_blank rel='nofollow'>LISTA STARTOWA</a></td></tr>
</table><td class='zdjecie'>ID#20261011-2</td></tr></table>`

test('the ZAPISY page is the registration url', () => {
  // biegnijmy hosts its own sign-up form on the ZAPISY page. After the deadline
  // the same page says "ZAPISY ELEKTRONICZNE ZOSTAŁY ZAKOŃCZONE".
  const [row] = parseListing(ROW)
  assert.equal(row.source_id, '20261011-2-swidwin')
  assert.equal(row.registration_url, 'https://biegnijmy.pl/index.php?kat=zapisy/20261011-2-swidwin&plik=zapisy')
})

test('the event page linked from the name is the source url', () => {
  const [row] = parseListing(ROW)
  assert.equal(row.source_url, 'https://biegnijmy.pl/nordic-walking-wokol-jeziora-bukowiec-swidwin-2026')
})

test('LISTA STARTOWA is never taken for the ZAPISY link', () => {
  const html = ROW.replace(/<a class='naglowekbiegu' href='[^']*plik=zapisy'[^>]*>ZAPISY<\/a>/, '')
  const [row] = parseListing(html)
  assert.equal(row.registration_url, null)
})

test('a row with no ZAPISY link and no event page gets no registration url', () => {
  const html = ROW
    .replace(/<a class='naglowekbiegu' href='[^']*plik=zapisy'[^>]*>ZAPISY<\/a>/, '')
    .replace(/<a href=\/nordic[^>]*>/, '<a>')
  const [row] = parseListing(html)
  assert.equal(row.registration_url, null)
  assert.equal(row.source_id, '20261011-2-swidwin')
  assert.equal(row.source_url, 'https://biegnijmy.pl/index.php?kat=zapisy/20261011-2-swidwin&plik=zapisy')
})

// index.php?plik=imprezy&co=<YEAR>- lists only events from today backwards: on
// 2026-11-08 the 2026 page ended at 2026-11-08 Warcino, the 2027 page was empty,
// and every scraper_biegnijmy row had been created on or after its race day.
// Upcoming events are listed only on index.php?plik=zapowiedzi, in the same rows.
const UPCOMING = ROW
  .replaceAll('20261011-2-swidwin', '20261212-1-swidwin')
  .replace('ID#20261011-2', 'ID#20261212-1')
  .replace('2026-10-11, Świdwin', '2026-12-12, Świdwin')
  .replace('Nordic Walking wokół jeziora Bukowiec (jez. Bukowiec)', 'Dwumaraton Świdwiński')

test('scrape reads the upcoming-events page, not only the past-events archive', async () => {
  const fetched = []
  const fetchHtml = async (url) => {
    fetched.push(url)
    return /plik=zapowiedzi/.test(url) ? UPCOMING : (/co=2026-/.test(url) ? ROW : '')
  }
  const { scrape } = await import('../src/scrapers/sources/biegnijmy.js')
  const events = await scrape({ fetchHtml, now: new Date('2026-11-08T12:00:00Z'), delayMs: 0 })
  assert.ok(fetched.includes('https://biegnijmy.pl/index.php?plik=zapowiedzi'))
  const ids = events.map(e => e.source_id).sort()
  assert.deepEqual(ids, ['20261011-2-swidwin', '20261212-1-swidwin'])
  const upcoming = events.find(e => e.source_id === '20261212-1-swidwin')
  assert.equal(upcoming.date, '2026-12-12')
  assert.equal(upcoming.registration_url, 'https://biegnijmy.pl/index.php?kat=zapisy/20261212-1-swidwin&plik=zapisy')
})

test('an event on both pages comes from the upcoming-events page', async () => {
  const archived = ROW.replace(/<a class='naglowekbiegu' href='[^']*plik=zapisy'[^>]*>ZAPISY<\/a>/, '')
  const fetchHtml = async (url) => (/plik=zapowiedzi/.test(url) ? ROW : archived)
  const { scrape } = await import('../src/scrapers/sources/biegnijmy.js')
  const events = await scrape({ fetchHtml, now: new Date('2026-10-11T12:00:00Z'), delayMs: 0 })
  assert.equal(events.length, 1)
  assert.equal(events[0].registration_url, 'https://biegnijmy.pl/index.php?kat=zapisy/20261011-2-swidwin&plik=zapisy')
})
