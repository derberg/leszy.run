import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  raceresultEventId, rulesTabKeys, namesOtherYear, resolveRaceresultRegulamin,
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

test('only a tab labelled as the rules counts', () => {
  assert.deepEqual(rulesTabKeys(MENU, '412049'), ['extcontent'])
  assert.deepEqual(rulesTabKeys('<a href="/412049/extcontent">Mapa trasy</a>', '412049'), [])
})

test('a document URL naming another year is last edition\'s', () => {
  assert.equal(namesOtherYear('https://x.pl/regulamin/2022/r.pdf', '2027-01-16'), true)
  assert.equal(namesOtherYear(DOC, '2027-01-16'), false)
  assert.equal(namesOtherYear('https://x.pl/r.pdf', '2027-01-16'), false)
})

test('ZIMOWY ULTRA TURNICKI: the Regulamin tab yields the 2027 PDF', async () => {
  stub()
  assert.equal(await resolveRaceresultRegulamin(ROW), DOC)
})

test('a rules tab that is not a PDF is dropped', async () => {
  stub({ pdf: false })
  assert.equal(await resolveRaceresultRegulamin(ROW), null)
})

test('a video in the rules tab is dropped', async () => {
  stub({ configs: { extcontent: { Data: 'abc123', Subtype: 'youtube' } } })
  assert.equal(await resolveRaceresultRegulamin(ROW), null)
})

test('a rules tab pointing at last year\'s document is dropped', async () => {
  stub({ configs: { extcontent: { Data: 'http://s-time.pl/regulamin/2026/zut_regulamin.pdf', Subtype: '' } } })
  assert.equal(await resolveRaceresultRegulamin(ROW), null)
})

test('two rules tabs with two different documents are left to the search', async () => {
  const menu = MENU + '<a href="/412049/extcontent2">Regulamin 36 km</a>'
  stub({ menu, configs: {
    extcontent: { Data: DOC, Subtype: '' },
    extcontent2: { Data: 'http://s-time.pl/regulamin/2027/other.pdf', Subtype: '' },
  } })
  assert.equal(await resolveRaceresultRegulamin(ROW), null)
})

test('a row with no raceresult link never touches the network', async () => {
  const calls = stub()
  assert.equal(await resolveRaceresultRegulamin({ registration_url: 'https://dostartu.pl/x-v1', date: '2027-01-16' }), null)
  assert.deepEqual(calls, [])
})
