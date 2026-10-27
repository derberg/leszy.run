import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  raceresultEventId, rulesTabKeys, namesOtherYear, namesRaceDate, resolveRaceresultRegulamin,
} from '../scripts/lib/raceresult-regulamin.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// The menu of https://my.raceresult.com/412049/ as served on 2026-10-27.
const MENU = `<div id="divEventMenu" class="menu">
  <div class="selected"><a href="/412049/extcontent">Regulamin</a></div>
  <div class=""><a href="/412049/registration">Registration</a></div>
  <div class=""><a href="/412049/participants">Participants</a></div>
</div>`

const ROW = {
  name: 'ZIMOWY ULTRA TURNICKI', date: '2027-01-16',
  registration_url: 'https://my.raceresult.com/412049/registration',
}
const DOC = 'http://s-time.pl/regulamin/2027/zut_regulamin.pdf'
// The resolver's PDF text, as pdftotext reads the real document.
const TEXT_2027 = async () => 'Bieg Zimowy Ultra Turnicki odbędzie się 16 stycznia 2027 r.'
const resolve = (row, opts = {}) => resolveRaceresultRegulamin(row, { extractText: TEXT_2027, ...opts })

function stub({ menu = MENU, configs = { extcontent: { Data: DOC, Subtype: '' } }, pdf = true } = {}) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url); calls.push(url)
    const text = async () => ''
    if (url === 'https://my.raceresult.com/412049/') return { ok: true, text: async () => menu }
    const m = url.match(/412049\/([^/]+)\/config/)
    if (m) {
      const cfg = configs[m[1]]
      return cfg ? { ok: true, json: async () => cfg } : { ok: false, json: async () => ({}) }
    }
    // the document itself, asked for by verifyPdf
    return {
      ok: true, status: 200, text,
      headers: { get: () => (pdf ? 'application/pdf' : 'text/html') },
    }
  }
  return calls
}

test('the event id comes from the registration URL or the website', () => {
  assert.equal(raceresultEventId(ROW), '412049')
  assert.equal(raceresultEventId({ website: 'https://my.raceresult.com/412045/' }), '412045')
  assert.equal(raceresultEventId({ registration_url: 'https://dostartu.pl/x-v1' }), null)
})

test('only a tab labelled as this race\'s rules counts', () => {
  assert.deepEqual(rulesTabKeys(MENU, '412049'), ['extcontent'])
  // The real markup also carries an onclick with escaped slashes.
  const real = `<div class="selected" onclick="window.location.href='\\/412049\\/extcontent'"><a href="/412049/extcontent">Regulamin</a></div>`
  assert.deepEqual(rulesTabKeys(real, '412049'), ['extcontent'])
  for (const label of ['Mapa trasy', 'Regulamin cyklu', 'Regulamin Grand Prix', 'Regulamin klasyfikacji', 'Regulamin RODO', 'Polityka prywatności']) {
    assert.deepEqual(rulesTabKeys(`<a href="/412049/extcontent">${label}</a>`, '412049'), [], label)
  }
})

test('a file name naming another year is last edition\'s; an upload folder is not', () => {
  assert.equal(namesOtherYear('https://x.pl/uploads/2027/01/regulamin-2026.pdf', '2027-01-16'), true)
  assert.equal(namesOtherYear('https://x.pl/uploads/2026/11/regulamin.pdf', '2027-01-16'), false)
  assert.equal(namesOtherYear(DOC, '2027-01-16'), false)
  assert.equal(namesOtherYear('https://x.pl/regulamin_2027.pdf', '2027-01-16'), false)
  assert.equal(namesOtherYear('https://x.pl/r.pdf', '2027-01-16'), false)
})

test('labels a loose filter would wrongly refuse still count', () => {
  for (const label of ['Regulamin Biegu Ligowego', 'Regulamin obligatoryjny', 'Regulamin zawodów']) {
    assert.deepEqual(rulesTabKeys(`<a href="/412049/extcontent">${label}</a>`, '412049'), ['extcontent'], label)
  }
})

test('a malformed file name never throws', () => {
  assert.equal(namesOtherYear('https://x.pl/r%2.pdf', '2027-01-16'), false)
})

test('the document must name the race date, not just the year', () => {
  assert.equal(namesRaceDate('odbędzie się 16 stycznia 2027 r.', '2027-01-16'), true)
  assert.equal(namesRaceDate('termin: 16.01.2027', '2027-01-16'), true)
  assert.equal(namesRaceDate('16\nstycznia\n2027', '2027-01-16'), true)
  assert.equal(namesRaceDate('dane przechowywane do 31.12.2027', '2027-01-16'), false)
  assert.equal(namesRaceDate('17 stycznia 2026', '2027-01-16'), false)
  assert.equal(namesRaceDate('116 stycznia 2027', '2027-01-16'), false)
})

test('a row with no date is left to the search', async () => {
  const calls = stub()
  assert.equal(await resolve({ registration_url: ROW.registration_url }), null)
  assert.deepEqual(calls, [])
})

test('ZIMOWY ULTRA TURNICKI: the Regulamin tab yields the 2027 PDF', async () => {
  stub()
  assert.equal(await resolve(ROW), DOC)
})

test('a rules tab that is not a PDF is dropped', async () => {
  stub({ pdf: false })
  assert.equal(await resolve(ROW), null)
})

test('a video in the rules tab is dropped', async () => {
  stub({ configs: { extcontent: { Data: 'abc123', Subtype: 'youtube' } } })
  assert.equal(await resolve(ROW), null)
})

test('a rules tab pointing at last year\'s file name is dropped', async () => {
  stub({ configs: { extcontent: { Data: 'http://s-time.pl/regulamin/zut_regulamin_2026.pdf', Subtype: '' } } })
  assert.equal(await resolve(ROW), null)
})

test('a stable URL still holding last year\'s text is dropped', async () => {
  stub({ configs: { extcontent: { Data: 'https://org.pl/files/regulamin.pdf', Subtype: '' } } })
  const text2026 = async () => 'Bieg odbędzie się 17 stycznia 2026 r.'
  assert.equal(await resolve(ROW, { extractText: text2026 }), null)
})

test('an unreadable PDF is dropped', async () => {
  stub()
  assert.equal(await resolve(ROW, { extractText: async () => '' }), null)
})

test('a throttled event page is a miss, not an error', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => '' })
  assert.equal(await resolve(ROW), null)
})

test('a tab config without a Data field is skipped', async () => {
  stub({ configs: { extcontent: { key: 'x', contests: [] } } })
  assert.equal(await resolve(ROW), null)
})

test('two rules tabs pointing at the same document give that document', async () => {
  const menu = MENU + '<a href="/412049/extcontent2">Regulamin zawodów</a>'
  stub({ menu, configs: { extcontent: { Data: DOC, Subtype: '' }, extcontent2: { Data: DOC, Subtype: '' } } })
  assert.equal(await resolve(ROW), DOC)
})

test('the event id can come from the website alone', async () => {
  stub()
  assert.equal(await resolve({ date: '2027-01-16', website: 'https://my.raceresult.com/412049/' }), DOC)
})

test('two rules tabs with two different documents are left to the search', async () => {
  const menu = MENU + '<a href="/412049/extcontent2">Regulamin 36 km</a>'
  stub({ menu, configs: {
    extcontent: { Data: DOC, Subtype: '' },
    extcontent2: { Data: 'http://s-time.pl/regulamin/2027/other.pdf', Subtype: '' },
  } })
  assert.equal(await resolve(ROW), null)
})

test('a row with no raceresult link never touches the network', async () => {
  const calls = stub()
  assert.equal(await resolve({ registration_url: 'https://dostartu.pl/x-v1', date: '2027-01-16' }), null)
  assert.deepEqual(calls, [])
})
