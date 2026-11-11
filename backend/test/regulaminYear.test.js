import { test } from 'node:test'
import assert from 'node:assert/strict'
import { regulaminYear, isStaleRegulaminYear } from '../scripts/lib/regulaminYear.js'

const stale = (url, eventDate, eventName = '') => isStaleRegulaminYear({ url, eventDate, eventName })

test('a previous edition regulamin is stale', () => {
  assert.equal(stale('https://x.pl/Bieg%20Ma%C5%82y%20Patriota%202025%20Regulamin.docx_.pdf', '2026-11-15', 'Mały Patriota 2026'), true)
  assert.equal(stale('https://superczas.pl/userfiles/events/659/regulamin_kilometr-dla-wosp-2026_pl.pdf', '2027-01-31', 'Kilometr dla WOŚP 2027'), true)
  assert.equal(stale('https://biegikoszalin.eu/Biegi_Koszalin_2016/biegsyl2025', '2026-12-31', 'XVII Koszaliński Bieg Sylwestrowy'), true)
})

test('a season spanning two years in the file name is not stale', () => {
  const url = 'https://nkbchyzy.com/wp-content/uploads/2026/06/R-E-G-U-L-A-M-I-N-Dwumaraton-2026-27-1.1.pdf'
  assert.equal(regulaminYear(url), 2027)
  assert.equal(stale(url, '2027-03-13', '11 Dwumaraton Olęderski'), false)
})

test('a season in the event name covers a file naming its first year', () => {
  assert.equal(stale('https://sportaktywni.pl/userfiles/trail-on-2026-2027/TrailON-2026-regulamin-cyklu.pdf?ts=1', '2027-02-06', 'Trail!ON Stawiguda 2026/2027 #3'), false)
  assert.equal(stale('https://x.pl/Protour%20Cyclocross%20Cup%202026%20regulamin.pdf', '2027-01-03', 'PROTOUR CYCLOCROSS CUP SEZON 2026/27 - Stargard'), false)
  // a season that ended before the event does not excuse it
  assert.equal(stale('https://x.pl/regulamin-2025.pdf', '2027-01-03', 'Cup 2025/26'), true)
})

test('a year inside a timestamp or version string is not an edition year', () => {
  assert.equal(regulaminYear('https://www.bgtimesport.pl/public/pliki/888reg20261105t203443.pdf'), null)
  assert.equal(regulaminYear('https://sisxyz.pl/wp-content/uploads/2026/02/REGULAMIN_ZADEK_v222012026.pdf'), null)
  assert.equal(stale('https://www.bgtimesport.pl/public/pliki/868reg20260703t100534.pdf', '2027-01-22', 'ZAMIEĆ 2027'), false)
})

test('a date in the file name is not read as a season', () => {
  assert.equal(regulaminYear('https://x.pl/regulamin_2025-12-31.pdf'), 2025)
  assert.equal(regulaminYear('https://x.pl/20261220_Olawa_-_regulamin.pdf'), null)
})
