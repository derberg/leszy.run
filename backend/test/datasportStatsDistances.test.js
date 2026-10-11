import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDetailPage, needsDetail, shouldEmitRow, keepStoredRegulamin, scrape } from '../src/scrapers/sources/datasport.js'

// datasport reads distances from the <h4> race category headings in the section
// after #features. Event 12775 (25 BIEG MARATOŃCZYKA, 2026-12-20) runs on the
// newer "Panel zapisów" template: its #features section holds generic cards
// only (results, signup, group signup, list, stats) and the page has no <h4> at
// all, so distances landed null. The organizer did publish the category, but
// only in statcont/statystyki12775.json, which the stats page fetches
// client-side: distances.all = [{"name":"Bieg 10km"}].
// Shapes below mirror the real pages, sampled 2026-10-01.

const SPARSE_PAGE = `<html><body>
  <section id="features"><div class="container">
    <div class="card"><a href="https://liveds.datasport.pl/wyniki.html?zawody=12775"></a><h2>Wyniki</h2></div>
    <div class="card"><a href="https://liveds.datasport.pl/queue/?redirect_url=zapisy"></a><h2>Zapisy</h2></div>
    <div class="card"><a href="https://liveds.datasport.pl/listaaws.html?zawody=12775"></a><h2>Lista</h2></div>
    <div class="card"><a href="https://liveds.datasport.pl/stat.html?zawody=12775"></a><h2>Statystyki</h2></div>
  </div></section>
  <section><div class="container"></div></section>
</body></html>`

// The per-distance price tier tables are part of the real page and no code here
// reads them: scraper_datasport has no registration_deadline column ("42703
// column scraper_datasport.registration_deadline does not exist", checked
// 2026-10-01), so a parsed deadline would have nowhere to go. They stay in the
// fixture because the headings have to be found with them in the way.
const HEADING_PAGE = `<html><body>
  <section id="features"><div class="container"></div></section>
  <section><div class="container">
    <h4>Bieg 10km</h4>
    <table class="table"><tr><td>2026-10-01</td><td>2026-10-18</td><td>79.00 PLN</td></tr></table>
    <h4>Bieg 5 km</h4>
    <table class="table"><tr><td>2026-10-01</td><td>2026-10-18</td><td>79.00 PLN</td></tr></table>
  </div></section>
</body></html>`

const statsJson = (names) => JSON.stringify({
  ok: true,
  zawody: 12775,
  distances: { all: names.map(name => ({ name, count: 0 })) },
})

function stubFetch(handler) {
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    const body = handler(String(url))
    if (body === null) return { ok: false, status: 404 }
    // The event pages are windows-1250; the stats JSON is UTF-8.
    return {
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      json: async () => JSON.parse(body),
    }
  }
  return { urls, restore: () => { globalThis.fetch = original } }
}

test('a page with no category headings reads its distances from the stats JSON', async () => {
  const stub = stubFetch((url) =>
    url.includes('/statcont/') ? statsJson(['Bieg 10km']) : SPARSE_PAGE,
  )
  try {
    const detail = await fetchDetailPage('12775')
    assert.equal(detail.distances, '10 km')
    assert.ok(stub.urls.includes('https://liveds.datasport.pl/statcont/statystyki12775.json'))
  } finally {
    stub.restore()
  }
})

test('the stats JSON is not requested when the headings already gave distances', async () => {
  // The HTML page stays authoritative, and a page that parses costs one request.
  const stub = stubFetch((url) =>
    url.includes('/statcont/') ? statsJson(['Nordic Walking 15 km']) : HEADING_PAGE,
  )
  try {
    const detail = await fetchDetailPage('12785')
    assert.equal(detail.distances, '10 km, 5 km')
    assert.ok(!stub.urls.some(u => u.includes('/statcont/')))
  } finally {
    stub.restore()
  }
})

test('every category in the stats JSON is read, children included', async () => {
  const stub = stubFetch((url) =>
    url.includes('/statcont/')
      ? statsJson(['Bieg 21 km', 'Nordic Walking 15 km', 'Biegi dla dzieci: rocznik 2017 i młodsi'])
      : SPARSE_PAGE,
  )
  try {
    const detail = await fetchDetailPage('12713')
    assert.equal(detail.distances, '21 km, 15 km')
  } finally {
    stub.restore()
  }
})

test('a name with mangled Polish letters is not turned into a marathon', async () => {
  // datasport encodes the stats JSON distance names twice: event 12557's
  // "XI PÓŁMARATON PIASTOWSKI" is served as "PӣMARATON". That still matches
  // /maraton/ while no longer matching /pół/, so reading words there would
  // publish 42.2 km for a half marathon. Only the digits are read.
  const stub = stubFetch((url) =>
    url.includes('/statcont/')
      ? statsJson(['PӣMARATON', 'BIEG DLA KAŻDEGO', 'NORDIC WALKING'])
      : SPARSE_PAGE,
  )
  try {
    const detail = await fetchDetailPage('12557')
    assert.equal(detail.distances, '')
  } finally {
    stub.restore()
  }
})

test('a heading still reads a distance spelled as a word', async () => {
  // Heading text is ASCII here because the stub encodes UTF-8 while the scraper
  // decodes windows-1250; the scraper matches the stripped spelling too.
  const stub = stubFetch(() => `<html><body>
    <section id="features"></section>
    <section><h4>Polmaraton</h4><h4>Bieg 6H</h4></section>
  </body></html>`)
  try {
    const detail = await fetchDetailPage('12345')
    assert.equal(detail.distances, '21.1 km, 6h')
  } finally {
    stub.restore()
  }
})

test('a relay leg is not published as the race distance', async () => {
  // The stats JSON lists results categories, so relay and age-group names reach
  // the parser that the <h4> headings never carried. "Sztafeta 4x5km" is four
  // legs of five: reading 5 km there publishes a fifth of the race. Same rule as
  // the mangled half marathon — no distance beats a wrong one.
  const stub = stubFetch((url) =>
    url.includes('/statcont/')
      ? statsJson(['Sztafeta 4x5km', 'Sztafeta 4 x 5 km', 'Bieg 10 km'])
      : SPARSE_PAGE,
  )
  try {
    const detail = await fetchDetailPage('12142')
    assert.equal(detail.distances, '10 km')
  } finally {
    stub.restore()
  }
})

test('a missing stats JSON leaves distances empty instead of throwing', async () => {
  const stub = stubFetch((url) => (url.includes('/statcont/') ? null : SPARSE_PAGE))
  try {
    const detail = await fetchDetailPage('12775')
    assert.equal(detail.distances, '')
  } finally {
    stub.restore()
  }
})

// The rows that were published without distances are already in the raw table,
// and a known source_id was skipped outright, so the fix above would never have
// reached them: 30 future datasport rows hold no distances today.

const LIST_PAGE = `<html><body>
  <div class="event-list-box">
    <h5><a href="zawody_files/zawody12775.html">25 BIEG MARATONCZYKA</a></h5>
    <ul><li>SZCZECIN</li></ul>
    <p>2026-12-20</p>
  </div>
</body></html>`

const KNOWN_IDS = new Set(['12775'])

test('a stored row with no distances is read again and gains them', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/lista.html')) return LIST_PAGE
    if (url.includes('/statcont/')) return statsJson(['Bieg 10km'])
    return SPARSE_PAGE
  })
  try {
    const rows = await scrape({
      knownIds: KNOWN_IDS,
      knownRows: new Map([['12775', { source_id: '12775', date: '2026-12-20', distances: null }]]),
      today: '2026-10-01',
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].distances, '10 km')
  } finally {
    stub.restore()
  }
})

test('a stored row that already has distances is not read again', () => {
  const entry = { sourceId: '12785', date: '2027-04-04' }
  const known = new Map([['12785', { source_id: '12785', date: '2027-04-04', distances: '10 km, 5 km' }]])
  assert.equal(needsDetail(entry, new Set(['12775', '12785']), known, '2026-10-01'), false)
})

test('a past race with no distances is left alone', () => {
  const entry = { sourceId: '12775', date: '2026-09-01' }
  const known = new Map([['12775', { source_id: '12775', date: '2026-09-01', distances: null }]])
  assert.equal(needsDetail(entry, KNOWN_IDS, known, '2026-10-01'), false)
})

test('a known row with no stored values keeps the old skip', () => {
  // knownRows is empty when the source declares no knownColumns — re-fetching
  // every known page blind is not what the re-check is for.
  assert.equal(needsDetail({ sourceId: '12775', date: '2026-12-20' }, KNOWN_IDS, new Map(), '2026-10-01'), false)
})

test('an unreadable detail page on a known row writes nothing', () => {
  // A re-scrape is authoritative for its own record, so a row built from a null
  // detail would overwrite a stored regulamin PDF with null.
  assert.equal(shouldEmitRow(null, true), false)
  assert.equal(shouldEmitRow(null, false), true)
  assert.equal(shouldEmitRow({ distances: '10 km', regulaminUrl: null }, true), true)
})

test('a re-check that finds no regulamin anchor keeps the stored PDF', async () => {
  // shouldEmitRow covers an unreadable page only. SPARSE_PAGE reads fine and
  // carries no regulamin link, and runPipeline's existing-row path writes the
  // whole mapped field set, so an un-carried null would delete the stored PDF
  // from the raw table — 18 of the 30 rows in the re-check set hold one.
  const stub = stubFetch((url) => {
    if (url.includes('/lista.html')) return LIST_PAGE
    if (url.includes('/statcont/')) return statsJson(['Bieg 10km'])
    return SPARSE_PAGE
  })
  try {
    const rows = await scrape({
      knownIds: KNOWN_IDS,
      knownRows: new Map([['12775', {
        source_id: '12775',
        date: '2026-12-20',
        distances: null,
        regulamin_url: 'https://liveds.datasport.pl/regulaminy/regulamin_12775.pdf',
      }]]),
      today: '2026-10-01',
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].distances, '10 km')
    assert.equal(rows[0].regulamin_url, 'https://liveds.datasport.pl/regulaminy/regulamin_12775.pdf')
  } finally {
    stub.restore()
  }
})

test('a freshly read regulamin replaces the stored one, and a new row has none to keep', () => {
  const stored = { regulamin_url: 'https://liveds.datasport.pl/regulaminy/regulamin_12775.pdf' }
  assert.equal(keepStoredRegulamin(null, stored), stored.regulamin_url)
  assert.equal(keepStoredRegulamin('https://example.org/nowy.pdf', stored), 'https://example.org/nowy.pdf')
  assert.equal(keepStoredRegulamin(null, undefined), null)
  assert.equal(keepStoredRegulamin(null, { regulamin_url: null }), null)
})
