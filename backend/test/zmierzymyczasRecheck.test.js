import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrape, needsDetail } from '../src/scrapers/sources/zmierzymyczas.js'

// zmierzymyczas publishes the event page before it opens registration. Row 2664
// (XIX JELCZAŃSKO-OŁAWSKI TOYOTA ZIMOWY MARATON NA RATY, 2027-01-10) was scraped
// at 06:26 UTC on 2026-09-14, when the page still read "Zapisy zostaną otwarte
// 14-09-2026 o 14:09" and had no /edit/ anchor. By 13:03 UTC the same page carried
// <a href="/edit/2664/..." class="link-form">Formularz rejestracyjny</a>.
// Shapes below mirror the real listing row and detail page, sampled 2026-09-14.

const listingRow = (id, slug, date, name) => `
  <tr>
    <td id="zapisy_list_data"><a href="/${id}/${slug}.html">${date}</a></td>
    <td id="zapisy_list_nazwa"><a href="/${id}/${slug}.html">${name}</a></td>
    <td id="zapisy_list_dystans"><a href="/${id}/${slug}.html">7,033 km</a></td>
    <td id="zapisy_list_miejsce"><a href="/${id}/${slug}.html">Chwałowice</a></td>
  </tr>`

const SLUG = 'xix-jelczansko-olawski-toyota-zimowy-maraton-na-raty'
const NAME = 'XIX JELCZAŃSKO-OŁAWSKI TOYOTA ZIMOWY MARATON NA RATY'

const listing = `<html><body><table class="table-bordered zebra"><tbody>
  ${listingRow('2664', SLUG, '2027-01-10', NAME)}
  ${listingRow('2660', 'x-koszecinska-dycha', '2026-11-21', 'X Koszęcińska Dycha')}
</tbody></table></body></html>`

const detailWithForm = (id, slug) => `<html><body>
  <a href="/images/regulaminy/${id}_regulamin_zawodow.pdf">Regulamin</a>
  <a href="/edit/${id}/${slug}.html" class="link-form">Formularz rejestracyjny</a>
</body></html>`

const detailBeforeRegistrationOpens = (id) => `<html><body>
  <a href="/images/regulaminy/${id}_regulamin_zawodow.pdf">Regulamin</a>
  <p>Zapisy zostaną otwarte 14-09-2026 o 14:09</p>
</body></html>`

// Records every URL the scraper asks for, so a test can assert a page was NOT read.
function stubFetch(pages) {
  const asked = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    const body = pages(String(url))
    return { ok: body !== null, text: async () => body ?? '' }
  }
  return { asked, restore: () => { globalThis.fetch = original } }
}

const pagesWithOpenRegistration = (url) => {
  if (url === 'https://www.zmierzymyczas.pl/') return listing
  if (url.includes('/2664/')) return detailWithForm('2664', SLUG)
  if (url.includes('/2660/')) return detailWithForm('2660', 'x-koszecinska-dycha')
  return null
}

test('a known row with no registration_url is read again once registration opens', async () => {
  // The defect: 2664 is already in scraper_zmierzymyczas, so it was dropped before
  // the detail fetch on every later run and its registration_url stayed null forever.
  const stub = stubFetch(pagesWithOpenRegistration)
  try {
    const events = await scrape({
      knownIds: new Set(['2664', '2660']),
      knownRows: new Map([
        ['2664', { source_id: '2664', date: '2027-01-10', registration_url: null }],
        ['2660', { source_id: '2660', date: '2026-11-21', registration_url: 'https://www.zmierzymyczas.pl/edit/2660/x-koszecinska-dycha.html' }],
      ]),
    })

    const found = events.find(e => e.source_id === '2664')
    assert.ok(found, '2664 must be emitted again while its registration_url is null')
    assert.equal(
      found.registration_url,
      `https://www.zmierzymyczas.pl/edit/2664/${SLUG}.html`,
    )
    assert.equal(
      found.regulamin_url,
      'https://www.zmierzymyczas.pl/images/regulaminy/2664_regulamin_zawodow.pdf',
    )

    // A known row that already has the link costs no request.
    assert.equal(events.some(e => e.source_id === '2660'), false)
    assert.equal(stub.asked.some(u => u.includes('/2660/')), false)
  } finally {
    stub.restore()
  }
})

test('a re-checked row whose registration is still closed stays null', async () => {
  const stub = stubFetch((url) => {
    if (url === 'https://www.zmierzymyczas.pl/') return listing
    if (url.includes('/2664/')) return detailBeforeRegistrationOpens('2664')
    return null
  })
  try {
    const events = await scrape({
      knownIds: new Set(['2664', '2660']),
      knownRows: new Map([
        ['2664', { source_id: '2664', date: '2027-01-10', registration_url: null }],
        ['2660', { source_id: '2660', date: '2026-11-21', registration_url: 'https://x/edit' }],
      ]),
    })
    const found = events.find(e => e.source_id === '2664')
    assert.ok(found)
    assert.equal(found.registration_url, null)
  } finally {
    stub.restore()
  }
})

test('a new source_id is still fetched', async () => {
  const stub = stubFetch(pagesWithOpenRegistration)
  try {
    const events = await scrape({ knownIds: new Set(['2660']), knownRows: new Map() })
    assert.deepEqual(events.map(e => e.source_id), ['2664'])
  } finally {
    stub.restore()
  }
})

test('needsDetail leaves a past race alone', () => {
  const entry = { sourceId: '2664' }
  const knownIds = new Set(['2664'])
  const rows = new Map([['2664', { date: '2026-09-13', registration_url: null }]])
  assert.equal(needsDetail(entry, knownIds, rows, '2026-09-14'), false)
  // Race day itself still counts as future — registration can open that morning.
  const today = new Map([['2664', { date: '2026-09-14', registration_url: null }]])
  assert.equal(needsDetail(entry, knownIds, today, '2026-09-14'), true)
})

test('needsDetail keeps the plain skip when the stored row is unavailable', () => {
  // knownRows is empty unless the source declares knownColumns. Without the stored
  // values there is nothing to compare, so a known id must not be re-fetched blind.
  assert.equal(
    needsDetail({ sourceId: '2664' }, new Set(['2664']), new Map(), '2026-09-14'),
    false,
  )
  assert.equal(
    needsDetail({ sourceId: '2999' }, new Set(['2664']), new Map(), '2026-09-14'),
    true,
  )
})
