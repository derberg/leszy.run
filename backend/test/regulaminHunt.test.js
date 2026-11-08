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
