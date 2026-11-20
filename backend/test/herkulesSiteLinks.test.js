import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siteLinks, isPlatformRoot } from '../src/scrapers/sources/herkules.js'

// biegikoszalin.eu as served on 2026-11-20 (a b4sportonline white-label site),
// cut to the menu and cards that matter. Herkules' "Witryna internetowa" for
// XVIII KOSZALIŃSKI BIEG GÓRSKI is the bare site, which the scraper used to
// publish as the registration URL.
const KOSZALIN = `
<ul>
<li><a title="/Biegi_Koszalin_2016/regbg2027" href = "/Biegi_Koszalin_2016/regbg2027" >Regulamin - XVIII Koszaliński Bieg Górski</a></li>
<li><a href = "/Biegi_Koszalin_2016/mpm" >Regulamin - 4. MP MASTERS W BIEGU GÓRSKIM</a></li>
<li><a href = "/Biegi_Koszalin_2016/bieg_sylwestrowy" >Regulamin - XVII Koszaliński Bieg Sylwestrowy</a></li>
<li><a href = "#" >31.12.2026 - XVII Koszaliński Bieg Sylwestrowy - 5km</a><ul>
  <li><a href = "/Biegi_Koszalin_2016/zapisy_na_31122026__xvii_koszalinski_bieg_sylwestrowy__5km" >Zapisy</a></li></ul></li>
<li><a href = "#" >31.12.2026 - Sylwestrowy Nordic Walking - 3,4km</a><ul>
  <li><a href = "/Biegi_Koszalin_2016/zapisy_na_31122026__sylwestrowy_nordic_walking__34km" >Zapisy</a></li></ul></li>
<li><a href = "#" >10.04.2027 - XVIII KOSZALIŃSKI BIEG GÓRSKI</a><ul>
  <li><a href = "/Biegi_Koszalin_2016/zapisy_na_10042027__xviii_koszalinski_bieg_gorski" >Zapisy</a></li>
  <li><a href = "/Biegi_Koszalin_2016/lista_uczestnikow_10042027__xviii_koszalinski_bieg_gorski/13434" >Lista uczestników</a></li></ul></li>
<li><a href = "/Biegi_Koszalin_2016/zapisy_na_10042027__4mistrzostwa_polski_masters_w_biegach_gorskich" >Zapisy</a></li>
<li><a href = "/Biegi_Koszalin_2016/zapisy_na_10042027__4mistrzostwa_polski_masters_w_biegach_gorskich_5km" >Zapisy</a></li>
<li><a href = "/Biegi_Koszalin_2016/zapisy_na_10042027__4mistrzostwa_polski_masters_w_biegach_gorskich_5_km_kobiety" >Zapisy</a></li>
</ul>
<a href="https://b4sportonline.pl/Biegi_Koszalin_2016/mpm">Regulamin &nbsp;</a>
`

const KOSZALIN_URL = 'https://biegikoszalin.eu/'

test('the registration link is the card for the race on its date', () => {
  const links = siteLinks(KOSZALIN, KOSZALIN_URL, { name: 'XVIII KOSZALIŃSKI BIEG GÓRSKI', date: '2027-04-10' })
  assert.equal(links.registrationUrl, 'https://biegikoszalin.eu/Biegi_Koszalin_2016/zapisy_na_10042027__xviii_koszalinski_bieg_gorski')
})

test('the regulamin is the menu entry naming the race, not another race of the site', () => {
  const links = siteLinks(KOSZALIN, KOSZALIN_URL, { name: 'XVIII KOSZALIŃSKI BIEG GÓRSKI', date: '2027-04-10' })
  assert.equal(links.regulaminUrl, 'https://biegikoszalin.eu/Biegi_Koszalin_2016/regbg2027')
})

test('the sylwestrowy race on the same site gets its own card and rules', () => {
  const links = siteLinks(KOSZALIN, KOSZALIN_URL, { name: 'XVII Koszaliński Bieg Sylwestrowy', date: '2026-12-31' })
  assert.equal(links.registrationUrl, 'https://biegikoszalin.eu/Biegi_Koszalin_2016/zapisy_na_31122026__xvii_koszalinski_bieg_sylwestrowy__5km')
  assert.equal(links.regulaminUrl, 'https://biegikoszalin.eu/Biegi_Koszalin_2016/bieg_sylwestrowy')
})

test('several equally good cards on the date give no registration link', () => {
  const links = siteLinks(KOSZALIN, KOSZALIN_URL, {
    name: '4 Mistrzostwa Polski Masters w Biegu Górskim w Stylu Anglosaskim', date: '2027-04-10',
  })
  assert.equal(links.registrationUrl, null)
  assert.equal(links.regulaminUrl, 'https://biegikoszalin.eu/Biegi_Koszalin_2016/mpm')
})

test('no card on the race date gives no registration link', () => {
  const links = siteLinks(KOSZALIN, KOSZALIN_URL, { name: 'XVIII KOSZALIŃSKI BIEG GÓRSKI', date: '2027-04-11' })
  assert.equal(links.registrationUrl, null)
})

// b4sportonline.pl/biegi_kolobrzeg/ on 2026-11-20: one race, one plain
// "Regulamin" button repeated.
const KOLOBRZEG = `
<a href = "/biegi_kolobrzeg/zapisy_na_20032027__kolobrzeska_15stka_zaslubin" >Zapisy</a>
<a href="https://b4sportonline.pl/biegi_kolobrzeg/zapisy_na_20032027__kolobrzeska_15stka_zaslubin">Zapisz się&nbsp;</a>
<a href = "/biegi_kolobrzeg/reg15" >Regulamin</a>
<a href="https://b4sportonline.pl/biegi_kolobrzeg/reg15">Regulamin &nbsp;</a>
`

test('a site with one plain Regulamin button uses it', () => {
  const links = siteLinks(KOLOBRZEG, 'https://b4sportonline.pl/biegi_kolobrzeg/', {
    name: 'Kołobrzeska 15-stka Zaślubin', date: '2027-03-20',
  })
  assert.equal(links.registrationUrl, 'https://b4sportonline.pl/biegi_kolobrzeg/zapisy_na_20032027__kolobrzeska_15stka_zaslubin')
  assert.equal(links.regulaminUrl, 'https://b4sportonline.pl/biegi_kolobrzeg/reg15')
})

test('a platform root is no website', () => {
  assert.equal(isPlatformRoot('https://b4sportonline.pl/'), true)
  assert.equal(isPlatformRoot('https://inws.info'), true)
  assert.equal(isPlatformRoot('https://b4sportonline.pl/biegi_kolobrzeg/'), false)
  assert.equal(isPlatformRoot('https://biegikoszalin.eu/'), false)
})

// b4sportonline.pl/polmaraton_kolobrzeg/ and /bieg_mikolajkowy_w_policach/ on
// 2026-11-20: card slugs with no date.
test('an undated card counts when it names the race', () => {
  const html = '<a href = "/polmaraton_kolobrzeg/zapisy_na_iv_kolobrzeski_polmaratron_brzegiem_baltyku" >Zapisy</a>'
  const links = siteLinks(html, 'https://b4sportonline.pl/polmaraton_kolobrzeg/', {
    name: 'IV  KOŁOBRZESKI PÓŁMARATON BRZEGIEM BAŁTYKU', date: '2027-05-16',
  })
  assert.equal(links.registrationUrl, 'https://b4sportonline.pl/polmaraton_kolobrzeg/zapisy_na_iv_kolobrzeski_polmaratron_brzegiem_baltyku')
})

test('undated cards that do not name the race give nothing', () => {
  const html = `
    <a href = "/bieg_mikolajkowy_w_policach/zapisy_na_bieg_glowny_na_5_km_i_10_km" >Zapisy</a>
    <a href = "/bieg_mikolajkowy_w_policach/zapisy_na_nordic_walking_5" >Zapisy</a>`
  const links = siteLinks(html, 'https://b4sportonline.pl/bieg_mikolajkowy_w_policach/', {
    name: 'XIV BIEG MIKOŁAJKOWY', date: '2026-12-06',
  })
  assert.equal(links.registrationUrl, null)
})

test('a card dated for another day is never taken as undated', () => {
  const html = '<a href = "/x/zapisy_na_01012027__iv_kolobrzeski_polmaraton_brzegiem_baltyku" >Zapisy</a>'
  const links = siteLinks(html, 'https://b4sportonline.pl/x/', {
    name: 'IV KOŁOBRZESKI PÓŁMARATON BRZEGIEM BAŁTYKU', date: '2027-05-16',
  })
  assert.equal(links.registrationUrl, null)
})
