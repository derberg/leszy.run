import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlatformRootUrl } from '../src/lib/registrationPlatforms.js'
import { AI_FILLABLE, applyRegistryUpdates, pickFillable } from '../scripts/lib/ai-fillable.js'

// VII Bieg Pocztyliona, 2026-09-20, Cewice. The enricher stored
// https://zapisy.info/ as its registration_url. That page lists every upcoming
// race on the platform, including this one, so every "does the page mention the
// event?" gate passed it. The race's own page is https://zapisy.info/imprezy/718/
// and it is the one that carries the registration window.
const POCZTYLION = {
  id: 'row-pocztylion',
  name: 'VII Bieg Pocztyliona',
  date: '2026-09-20',
  location: 'Cewice',
  voivodeship: 'Pomorskie',
}

test('a registration platform homepage is a platform root', () => {
  assert.equal(isPlatformRootUrl('https://zapisy.info/'), true)
  assert.equal(isPlatformRootUrl('https://zapisy.info'), true)
  assert.equal(isPlatformRootUrl('http://www.zmierzymyczas.pl'), true)
  assert.equal(isPlatformRootUrl('https://dostartu.pl/'), true)
  assert.equal(isPlatformRootUrl('https://elektronicznezapisy.pl'), true)
})

test('a share link to a platform homepage is still the homepage', () => {
  assert.equal(isPlatformRootUrl('https://superczas.pl/?fbclid=IwY2xjawTZy1lw'), true)
  assert.equal(isPlatformRootUrl('https://zapisy.inessport.pl/?fbclid=IwY2xjawQkCLp'), true)
  assert.equal(isPlatformRootUrl('https://www.zmierzymyczas.pl/?fbclid=IwY2&brid=YWdncw'), true)
})

test("a platform's own event page is not a root", () => {
  assert.equal(isPlatformRootUrl('https://zapisy.info/imprezy/718/'), false)
  assert.equal(isPlatformRootUrl('https://dostartu.pl/permalink-v12345'), false)
  assert.equal(isPlatformRootUrl('https://zapisy.inessport.pl/#gr291'), false)
  assert.equal(
    isPlatformRootUrl('https://online.datasport.pl/zapisy/portal/zawody.php?zawody=51'),
    false,
  )
})

test('an organizer domain with an empty path is not a root', () => {
  // These are real registration_url values. Each one is that race's own site,
  // so an empty path there is the whole address, not a directory of races.
  assert.equal(isPlatformRootUrl('https://naszadycha.pl'), false)
  assert.equal(isPlatformRootUrl('https://cracoviapolmaraton.pl'), false)
  assert.equal(isPlatformRootUrl('https://sopotpolmaraton.com/'), false)
  // A race that gets its own subdomain on a platform: the subdomain IS the event.
  assert.equal(isPlatformRootUrl('https://5.biegnijmy.pl'), false)
})

test('junk is not a root', () => {
  assert.equal(isPlatformRootUrl(null), false)
  assert.equal(isPlatformRootUrl(''), false)
  assert.equal(isPlatformRootUrl('zapisy.info'), false)
})

test('the enrichers refuse a platform homepage as registration_url', () => {
  const registry = pickFillable(['registration_url'])
  const updates = applyRegistryUpdates(
    POCZTYLION,
    { registration_url: 'https://zapisy.info/' },
    ['registration_url'],
    registry,
  )
  assert.deepEqual(updates, {})
})

test('the enrichers keep the event page on the same platform', () => {
  const registry = pickFillable(['registration_url'])
  const updates = applyRegistryUpdates(
    POCZTYLION,
    { registration_url: 'https://zapisy.info/imprezy/718/' },
    ['registration_url'],
    registry,
  )
  assert.deepEqual(updates, { registration_url: 'https://zapisy.info/imprezy/718/' })
})

test('regulamin_url is untouched by the platform-root rule', () => {
  // A rules document is often hosted on the platform, and a root-looking link
  // there is a different problem from a registration link. Only registration_url
  // is gated.
  assert.equal(AI_FILLABLE.regulamin_url.validate('https://zapisy.info/'), 'https://zapisy.info/')
})
