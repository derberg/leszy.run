import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { enrichFromUrl } from '../src/scrapers/apiEnrich.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stubDostartu(competition) {
  globalThis.fetch = async (url) => {
    const body = String(url).endsWith('/classifications')
      ? { classifications: [] }
      : { competition }
    return { ok: true, json: async () => body }
  }
}

test('a dostartu statute file path is stored as an absolute URL', async () => {
  // #181 fixed this in the dostartu scraper, but apiEnrich kept writing the API's
  // bare "statute_files/<id>_pl.pdf". On 2026-10-27 78 scraper_all rows held
  // such a path and run-enrich-from-regulamin skipped every one with "Failed to
  // parse URL", although the absolute form answers 200 application/pdf (17498,
  // 17488, 17446, 17453 checked that day).
  stubDostartu({ statuteFilePl: 'statute_files/17498_pl.pdf' })
  const out = await enrichFromUrl({ name: 'Zimowa Zawierucha 2027', registration_url: 'https://dostartu.pl/zimowa-zawierucha-v17498' })
  assert.equal(out.regulamin_url, 'https://dostartu.pl/statute_files/17498_pl.pdf')
})

test('the organizer\'s own statute link still wins over the dostartu copy', async () => {
  stubDostartu({ statuteLinkPl: 'https://klub.pl/regulamin.pdf', statuteFilePl: 'statute_files/1_pl.pdf' })
  const out = await enrichFromUrl({ name: 'X', registration_url: 'https://dostartu.pl/x-v1' })
  assert.equal(out.regulamin_url, 'https://klub.pl/regulamin.pdf')
})

test('a regulamin the scraper already set is kept', async () => {
  stubDostartu({ statuteFilePl: 'statute_files/1_pl.pdf' })
  const out = await enrichFromUrl({ name: 'X', registration_url: 'https://dostartu.pl/x-v1', regulamin_url: 'https://a.pl/r.pdf' })
  assert.equal(out.regulamin_url, 'https://a.pl/r.pdf')
})

test('the API\'s real shape (bare statuteLinkPl, absolute statuteFilePl) gives an absolute URL', async () => {
  stubDostartu({ statuteLinkPl: 'statute_files/17510_pl.pdf', statuteFilePl: 'https://dostartu.pl/statute_files/17510_pl.pdf' })
  const out = await enrichFromUrl({ name: 'X', registration_url: 'https://dostartu.pl/x-v17510' })
  assert.equal(out.regulamin_url, 'https://dostartu.pl/statute_files/17510_pl.pdf')
})

test('a failed competition fetch leaves regulamin_url empty', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
  const out = await enrichFromUrl({ name: 'X', registration_url: 'https://dostartu.pl/x-v1' })
  assert.equal(out.regulamin_url, null)
})
