import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrape } from '../src/scrapers/sources/zapisyonline.js'
import { changedKnownFields, sources } from '../src/scrapers/index.js'

// zapisyonline:1150, III CHARYTATYWNY BIEG MIKOŁAJKOWY - BIEGNIEMY DLA MICHAŁA
// (2026-12-06). The raw row was created on 2026-11-03 with regulamin_url null.
// The organizer uploaded a .docx regulamin later (last-modified 2026-11-08).
// scrape() fetched detail for new ids only, so the page was never read again
// and the regulamin never reached calendar_events.
const zapisyonline = sources.find((s) => s.name === 'zapisyonline')

const listing = `<html><body>
  <div class="event headers"><div class="item name">Nazwa</div></div>
  <div class="event">
    <div class="item date">06.12.2026</div>
    <div class="item place">Nehrybka</div>
    <div class="item name"><a href="/wydarzenie/1150,iii-charytatywny-bieg-mikolajkowy">III CHARYTATYWNY BIEG MIKOŁAJKOWY - BIEGNIEMY DLA MICHAŁA</a></div>
  </div>
</body></html>`

const RULES_HREF = '/files/_rules/1150/REGULAMIN III GMINNEGO CHARYTATYWNEGO BIEGU MIKOŁAJKOWEGO W NEHRYBCE.docx'

const detail = (rules) => `<html><body>
  <div class="competitions"><div class="events-list">
    <div class="event">
      <div class="item name">Bieg główny</div>
      <div class="item distance">5 km</div>
      <div class="item kind">Zawody dla dorosłych</div>
    </div>
  </div></div>
  ${rules ? `<a class="button" href="${rules}">Pobierz regulamin</a>` : ''}
  <div class="info article"><p>Zapraszamy.</p></div>
</body></html>`

function stubFetch(detailHtml) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    let body = null
    if (u.endsWith('/zapisy?p=0')) body = listing
    else if (u.includes('/zapisy?p=')) body = '<html><body></body></html>'
    else if (u.includes('/wydarzenie/1150')) body = detailHtml
    return { ok: body !== null, text: async () => body ?? '' }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const knownIds = new Set(['1150'])
const storedRow = { source_id: '1150', date: '2026-12-06', regulamin_url: null, registration_deadline: null }

test('a known future row with no regulamin is read again and gets the uploaded .docx', async () => {
  const stub = stubFetch(detail(RULES_HREF))
  try {
    const rows = await scrape({ knownIds, knownRows: new Map([['1150', storedRow]]), today: '2026-11-11', pauseMs: 0 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source_id, '1150')
    assert.equal(rows[0].regulamin_url, encodeURI(`https://zapisyonline.pl${RULES_HREF}`))
  } finally {
    stub.restore()
  }
})

test('the re-check writes only the regulamin, not the other stored fields', async () => {
  const stub = stubFetch(detail(RULES_HREF))
  try {
    const [raw] = await scrape({ knownIds, knownRows: new Map([['1150', storedRow]]), today: '2026-11-11', pauseMs: 0 })
    const row = zapisyonline.mapRow(raw)
    for (const field of ['distances', 'website', 'voivodeship', 'price_from', 'price_to', 'lat', 'lng', 'is_kids', 'event_types', 'location', 'registration_url']) {
      assert.equal(field in row, false, `${field} must not be overwritten`)
    }
    assert.deepEqual(changedKnownFields(row, storedRow, zapisyonline.knownColumns), ['regulamin_url'])
  } finally {
    stub.restore()
  }
})

test('a re-checked page that still has no regulamin emits nothing', async () => {
  const stub = stubFetch(detail(null))
  try {
    const rows = await scrape({ knownIds, knownRows: new Map([['1150', storedRow]]), today: '2026-11-11', pauseMs: 0 })
    assert.equal(rows.length, 0)
  } finally {
    stub.restore()
  }
})

test('a known row that already has a regulamin, or a past race, is not read again', async () => {
  for (const known of [
    { ...storedRow, regulamin_url: 'https://zapisyonline.pl/files/_rules/1150/old.pdf' },
    { ...storedRow, date: '2026-11-01' },
  ]) {
    const stub = stubFetch(detail(RULES_HREF))
    try {
      const rows = await scrape({ knownIds, knownRows: new Map([['1150', known]]), today: '2026-11-11', pauseMs: 0 })
      assert.equal(rows.length, 0)
      assert.equal(stub.calls.some((u) => u.includes('/wydarzenie/')), false)
    } finally {
      stub.restore()
    }
  }
})
