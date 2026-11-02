import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { eventShareFields, injectShareMeta, isEventSlug, polishDate, readEventShareFields, shortBlurb, competitionTags } from '../../src/lib/eventShareMeta.js'

const shell = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

const registration = {
  name: 'NieboCross 2027',
  eventDate: '2027-04-18',
  town: { label: 'Nieborowice' },
  description: 'Wydarzenie charytatywne "pamięci" <Marka>.',
  listed: false,
  isCharity: true,
  charityGoal: 'OTOZ Animals',
  competitions: [
    { distanceLabel: '3 km', discipline: 'run', kind: 'individual' },
    { distanceLabel: '9 km', discipline: 'nw', kind: 'individual' },
    { distanceLabel: '3 km', discipline: 'run', kind: 'team' },
    { discipline: 'run', isKids: true },
  ],
}

function meta(html, attr, key) {
  const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)
  return m && m[1]
}

describe('eventShareFields', () => {
  it('reads a registration event', () => {
    assert.deepEqual(eventShareFields(registration, null), {
      name: 'NieboCross 2027', date: '2027-04-18', location: 'Nieborowice',
      description: 'Wydarzenie charytatywne "pamięci" <Marka>.', noindex: true, distances: ['3 km', '9 km'],
      charity: 'OTOZ Animals', tags: ['BIEG', 'NORDIC WALKING', 'DZIECI', 'DRUŻYNY'],
    })
  })
  it('says nothing about charity for an ordinary event', () => {
    assert.equal(eventShareFields({ ...registration, isCharity: false }, null).charity, null)
    assert.equal(eventShareFields({ ...registration, charityGoal: null }, null).charity, '')
  })
  it('falls back to a public or unlisted events row', () => {
    const row = { name: 'NieboCross', date: '2026-04-12', location: 'Nieborowice', visibility: 'public' }
    assert.equal(eventShareFields(null, row).noindex, false)
    assert.equal(eventShareFields(null, { ...row, visibility: 'unlisted' }).noindex, true)
  })
  it('gives nothing for a private row or no row', () => {
    assert.equal(eventShareFields(null, { name: 'Szkic', visibility: 'private' }), null)
    assert.equal(eventShareFields(null, undefined), null)
  })
})

describe('injectShareMeta', () => {
  const html = injectShareMeta(shell, eventShareFields(registration, null), 'niebocross-2027')

  it('replaces the homepage title and preview with the event', () => {
    const title = 'NieboCross 2027 — 18 kwietnia 2027 — Leszy.run'
    assert.match(html, new RegExp(`<title>${title}</title>`))
    assert.equal(meta(html, 'property', 'og:title'), title)
    assert.equal(meta(html, 'name', 'twitter:title'), title)
    assert.equal(meta(html, 'property', 'og:url'), 'https://www.leszy.run/events/niebocross-2027')
    assert.equal(meta(html, 'property', 'og:image'), 'https://www.leszy.run/api/event-og?slug=niebocross-2027')
    assert.equal(meta(html, 'name', 'twitter:image'), 'https://www.leszy.run/api/event-og?slug=niebocross-2027')
    assert.match(html, /<link rel="canonical" href="https:\/\/www.leszy.run\/events\/niebocross-2027"/)
    assert.doesNotMatch(html, /content="Leszy.run — Pomiar czasu/)
  })
  it('escapes the organizer text', () => {
    assert.equal(meta(html, 'property', 'og:description'),
      'NieboCross 2027 — Nieborowice — 18 kwietnia 2027. Wydarzenie charytatywne &quot;pamięci&quot; &lt;Marka&gt;.')
  })
  it('keeps an unlisted event out of search', () => {
    assert.equal(meta(html, 'name', 'robots'), 'noindex, follow')
    const listed = injectShareMeta(shell, { ...eventShareFields(registration, null), noindex: false }, 'niebocross-2027')
    assert.equal(meta(listed, 'name', 'robots'), 'index, follow')
  })
  it('leaves the app bundle alone', () => {
    const scripts = s => s.match(/<script[^>]*src="[^"]*"/g)
    assert.deepEqual(scripts(html), scripts(shell))
  })
})

describe('helpers', () => {
  it('cuts a description at a word', () => {
    assert.equal(shortBlurb('Krótki opis.', 160), 'Krótki opis.')
    assert.equal(shortBlurb('Bieg  w\nlesie pod miastem, dla wszystkich', 30), 'Bieg w lesie pod miastem…')
    assert.ok(shortBlurb('x'.repeat(400), 160).length <= 160)
  })
  it('names kinds of entry, never each competition', () => {
    assert.deepEqual(competitionTags([{ discipline: 'nw' }, { discipline: 'nw' }]), ['NORDIC WALKING'])
    assert.deepEqual(competitionTags(undefined), [])
  })
  it('formats a Polish date', () => {
    assert.equal(polishDate('2027-04-18'), '18 kwietnia 2027')
    assert.equal(polishDate(''), '')
  })
  it('accepts only a slug', () => {
    assert.equal(isEventSlug('niebocross-2027'), true)
    assert.equal(isEventSlug('Niebo'), false)
    assert.equal(isEventSlug('a/../b'), false)
  })
})

describe('readEventShareFields', () => {
  function client({ registration = null, rows = [] }) {
    return {
      rpc: async () => ({ data: registration, error: null }),
      from: () => {
        const b = { select: () => b, eq: () => b, limit: async () => ({ data: rows, error: null }) }
        return b
      },
    }
  }
  it('prefers the registration document', async () => {
    assert.equal((await readEventShareFields(client({ registration }), 'x')).name, 'NieboCross 2027')
  })
  it('falls back to the events row', async () => {
    const rows = [{ name: 'Stary bieg', date: '2026-04-12', location: 'X', visibility: 'public' }]
    assert.equal((await readEventShareFields(client({ rows }), 'x')).name, 'Stary bieg')
  })
})
