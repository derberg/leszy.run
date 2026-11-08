import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { huntRegulamin, statesDate, regulaminLinks } from '../scripts/lib/regulaminHunt.js'

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8')
const regulamin = fixture('olawa-regulamin.txt')

function site(pages) {
  const asked = []
  const fetchDoc = async (url) => {
    asked.push(url)
    const p = pages[url]
    if (!p) return { error: 'HTTP 404' }
    return p.html ? { kind: 'html', html: p.html, text: p.text ?? p.html.replace(/<[^>]+>/g, ' ') } : { kind: 'pdf', text: p.text }
  }
  return { fetchDoc, asked }
}

test('statesDate reads the Polish ways of writing a date', () => {
  assert.ok(statesDate('Start 11 listopada 2026 r. o 11:00', '2026-11-11'))
  assert.ok(statesDate('termin: 13.12.2026', '2026-12-13'))
  assert.ok(statesDate('dnia 3.04.2027', '2027-04-03'))
  assert.ok(!statesDate('11 listopada 2025', '2026-11-11'))
  assert.ok(!statesDate('111 listopada 2026', '2026-11-01'))
})

test('regulaminLinks follows regulamin links and same-site pages naming the race, never a consent form', () => {
  const html = `
    <a href="/wp-content/uploads/GPC-regulamin.pdf">Regulamin GPC</a>
    <a href="/oswiadczenie-rodzica.pdf">Oświadczenie rodzica</a>
    <a href="/bieg-niepodleglosci/">XXVIII Bieg Niepodległości</a>
    <a href="https://elsewhere.pl/bieg-niepodleglosci/">XXVIII Bieg Niepodległości</a>
    <a href="https://facebook.com/regulamin">Regulamin</a>
    <a href="/kontakt/">Kontakt</a>`
  const links = regulaminLinks(html, 'http://gpclubianka.pl/regulamin/', 'XXVIII BIEG NIEPODLEGŁOŚCI').map((l) => l.url)
  assert.deepEqual(links.sort(), [
    'http://gpclubianka.pl/bieg-niepodleglosci/',
    'http://gpclubianka.pl/wp-content/uploads/GPC-regulamin.pdf',
  ])
})

test('finds the race regulamin two clicks from a rejected menu page, this edition over older ones', async () => {
  // gpclubianka.pl, 2026-11-08: /regulamin/ links the cycle's rules and a dead
  // PDF; the race page links this year's regulamin above every past edition's.
  const name = 'XXVIII BIEG NIEPODLEGŁOŚCI'
  const raceDoc = `REGULAMIN Biegu Niepodległości 11 listopada 2026 r.\n${regulamin}`
  const { fetchDoc } = site({
    'http://gpclubianka.pl/regulamin/': { html: `<a href="/up/REGULAMIN2026.pdf">Regulamin XXVII Bieg Niepodległości</a><a href="/bieg-niepodleglosci/">XXVIII Bieg Niepodległości</a>` },
    'http://gpclubianka.pl/bieg-niepodleglosci/': { html: `<h2>XXVIII Bieg Niepodległości</h2><a href="/up/REGULAMIN202666.pdf">LINK DO REGULAMINU</a><h2>XXVII</h2><a href="/up/REGULAMIN2025.pdf">LINK DO REGULAMINU</a>` },
    'http://gpclubianka.pl/up/REGULAMIN202666.pdf': { text: raceDoc },
    'http://gpclubianka.pl/up/REGULAMIN2025.pdf': { text: `REGULAMIN Biegu Niepodległości 11 listopada 2025 r.\n${regulamin}`.replace(/2026/g, '2025') },
  })
  const found = await huntRegulamin({
    row: { name, date: '2026-11-11', regulamin_url: 'http://gpclubianka.pl/regulamin/' },
    fetchDoc,
    skip: ['http://gpclubianka.pl/regulamin/'],
  })
  assert.equal(found?.url, 'http://gpclubianka.pl/up/REGULAMIN202666.pdf')
  assert.ok(found.statesDate)
})

test('a page reached because it names the race is not taken for the regulamin', async () => {
  // e-gepard's show-race page states the date, distances and organizer.
  const { fetchDoc } = site({
    'https://reg.example/contest/1': { html: '<a href="/race/2">Bieg Niepodległości 10 km</a>' },
    'https://reg.example/race/2': { html: '<p>x</p>', text: `Bieg Niepodległości 11.11.2026\n${regulamin}` },
  })
  const found = await huntRegulamin({
    row: { name: 'Bieg Niepodległości Pigża', date: '2026-11-11', registration_url: 'https://reg.example/contest/1' },
    fetchDoc,
  })
  assert.equal(found, null)
})

test("a platform's terms of service is not the race's regulamin", async () => {
  const { fetchDoc } = site({
    'https://platform.example/event/9': { html: '<a href="/regulamin-serwisu.pdf">Regulamin serwisu</a>' },
    'https://platform.example/regulamin-serwisu.pdf': { text: `Regulamin serwisu 2026\n${regulamin}` },
  })
  const found = await huntRegulamin({
    row: { name: 'Zimowy Maraton Wigierski', date: '2026-12-13', registration_url: 'https://platform.example/event/9' },
    fetchDoc,
  })
  assert.equal(found, null)
})

test('nothing to find returns null, within the fetch budget', async () => {
  const { fetchDoc, asked } = site({
    'https://kluki.pl/': { html: Array.from({ length: 40 }, (_, i) => `<a href="/regulamin-${i}.pdf">Regulamin ${i}</a>`).join('') },
  })
  const found = await huntRegulamin({
    row: { name: 'Rozbiegani w Gminie Kluki', date: '2026-11-15', regulamin_url: 'https://kluki.pl/' },
    fetchDoc,
    skip: ['https://kluki.pl/'],
    maxFetches: 8,
  })
  assert.equal(found, null)
  assert.ok(asked.length <= 8)
})

test('a news teaser that quotes a regulamin is not a link to one', () => {
  // kluki.pl, 2026-11-08: the asbestos-grant teaser mentions „Regulaminu wyboru przedsięwzięć”.
  const html = `<a href="/strona-3514-azbest.html">40 zł dofinansowania do wymiany 1 m2 azbestu. Agencja ogłasza nabór wniosków zgodnie z postanowieniami Regulaminu wyboru przedsięwzięć do objęcia wsparciem w gospodarstwach rolnych</a>`
  assert.deepEqual(regulaminLinks(html, 'https://kluki.pl/', 'Rozbiegani w Gminie Kluki'), [])
})

test("another race of the same organizer is not this race's regulamin", async () => {
  // b4sport ultra_swir, 2026-11-08: the autumn race's page links the summer
  // Wyspowy Ultra Świr 2027 rules, which name "Ultra Świr" and the year.
  const { fetchDoc } = site({
    'https://b4.example/ultra_swir/jesienny': { html: '<a href="/files/Regulamin_Wyspowy_Ultra_Swir_2027.pdf">Regulamin</a>' },
    'https://b4.example/files/Regulamin_Wyspowy_Ultra_Swir_2027.pdf': { text: `Regulamin Wyspowy Ultra Świr 2026/2027, 26.06.2027\n${regulamin}` },
  })
  const found = await huntRegulamin({
    row: { name: 'Jesienny ULTRA ŚWIR', date: '2026-11-28', registration_url: 'https://b4.example/ultra_swir/jesienny' },
    fetchDoc,
  })
  assert.equal(found, null)
})

test("an association's statute is not followed as a regulamin", () => {
  const html = '<a href="/o-nas/statut/">Statut</a><a href="/cross/regulamin.pdf">Regulamin</a>'
  const links = regulaminLinks(html, 'https://www.kondycja.com.pl/aktywnosci/cross-mikolajkowy/', '13. Cross Mikołajkowy')
  assert.deepEqual(links.filter((l) => l.labelled).map((l) => l.url), ['https://www.kondycja.com.pl/cross/regulamin.pdf'])
})

test('relative links resolve against where the redirects ended', async () => {
  // runvegan.pl/niedzwiedzibieg/ is served from niedzwiedzibieg.pl.
  const pages = {
    'https://runvegan.pl/niedzwiedzibieg/': { html: '<a href="regulamin.html">Regulamin</a>', finalUrl: 'https://niedzwiedzibieg.pl/' },
    'https://niedzwiedzibieg.pl/regulamin.html': { html: '<a href="/docs/regulamin.pdf">Pobierz PDF</a>' },
    'https://niedzwiedzibieg.pl/docs/regulamin.pdf': { text: `Regulamin II Biegu Niedźwiedziego, 21 listopada 2026\n${regulamin}` },
  }
  const fetchDoc = async (url) => {
    const p = pages[url]
    if (!p) return { error: 'HTTP 404' }
    return p.html ? { kind: 'html', html: p.html, text: p.html, finalUrl: p.finalUrl } : { kind: 'pdf', text: p.text }
  }
  const found = await huntRegulamin({
    row: { name: 'Niedźwiedzi Bieg 2026', date: '2026-11-21', regulamin_url: 'https://runvegan.pl/niedzwiedzibieg/' },
    fetchDoc,
    skip: ['https://runvegan.pl/niedzwiedzibieg/'],
  })
  assert.equal(found?.url, 'https://niedzwiedzibieg.pl/docs/regulamin.pdf')
})

test("this year's regulamin is reached before the budget goes on past editions", async () => {
  // bieglovelas.pl links eight past regulamins; 2026's sits on the race page.
  const old = Object.fromEntries([2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y) => [
    `https://ll.example/regulamin-ll${y}/`,
    { html: `<title>Regulamin LL${y}</title><p>x</p>`, text: `Regulamin ${y}\n${regulamin}` },
  ]))
  const menu = Object.keys(old).map((u, i) => `<a href="${u}">Regulamin ${2019 + i}</a>`).join('')
  const { fetchDoc } = site({
    'https://ll.example/': { html: `${menu}<a href="/lovelas-jesienia-2026/">Love'Las Jesienią 2026</a>` },
    'https://ll.example/lovelas-jesienia-2026/': { html: '<a href="/regulamin-ll2026/">Regulamin</a>' },
    'https://ll.example/regulamin-ll2026/': { html: '<title>Regulamin LL2026</title><p>Bieg 21 listopada 2026</p>', text: `Regulamin, bieg 21 listopada 2026\n${regulamin}` },
    ...old,
  })
  const found = await huntRegulamin({
    row: { name: "Love'Las JESIENIĄ", date: '2026-11-21', regulamin_url: 'https://ll.example/' },
    fetchDoc, skip: ['https://ll.example/'], maxFetches: 5,
  })
  assert.equal(found?.url, 'https://ll.example/regulamin-ll2026/')
})

test('a labelled link landing on a page that does not call itself a regulamin is not taken', async () => {
  // kondycja.com.pl: the "Regulamin" menu led to another race's page.
  const { fetchDoc } = site({
    'https://k.example/cross/': { html: '<a href="/inny-bieg/">Regulamin</a>' },
    'https://k.example/inny-bieg/': { html: '<title>II Memoriał</title><h1>II Memoriał</h1>', text: `Najbliżej: Cross Mikołajkowy 6.12.2026\n${regulamin}` },
  })
  const found = await huntRegulamin({
    row: { name: '13. Cross Mikołajkowy', date: '2026-12-06', regulamin_url: 'https://k.example/cross/' },
    fetchDoc, skip: ['https://k.example/cross/'],
  })
  assert.equal(found, null)
})

test("another race's page dated only by its sidebar is not taken", async () => {
  const { fetchDoc } = site({
    'https://k.example/cross/': { html: '<a href="/memorial/">Regulamin</a>' },
    'https://k.example/memorial/': {
      html: `<title>Regulamin II Memoriału</title><main><h1>Regulamin</h1><p>Memoriał, 14 marca 2027.</p></main><aside class="sidebar">Najbliższe: Cross Mikołajkowy 6 grudnia 2026</aside>`,
      text: `Regulamin II Memoriału 14 marca 2027 Cross Mikołajkowy 6 grudnia 2026\n${regulamin}`,
    },
  })
  const found = await huntRegulamin({
    row: { name: '13. Cross Mikołajkowy', date: '2026-12-06', regulamin_url: 'https://k.example/cross/' },
    fetchDoc, skip: ['https://k.example/cross/'],
  })
  assert.equal(found, null)
})
