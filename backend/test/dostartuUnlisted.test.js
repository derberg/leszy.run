import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlaceholderCompetition, unlistedCompetitions, WHITE_LABEL_HOSTS } from '../src/scrapers/sources/dostartu.js'
import { isDostartuLikeUrl, extractDostartuId } from '../src/scrapers/apiEnrich.js'

// Names below are real panel-listing rows from 2026-11-08.
test('onboarding, test, copy and template competitions are placeholders', () => {
  for (const name of [
    'Moje pierwsze zawody',
    'Moje pierwsze zawody- KOPIA',
    'Test',
    'test',
    'Test umów',
    'Test- nowy',
    'Testowe',
    'Teststoper start- KOPIA',
    'Marszobieg Test',
    'QR Test 1',
    'VI Półmaraton Gęstwinami Murckowskimi- KOPIA',
    'QR Demo - Template',
    '',
  ]) {
    assert.equal(isPlaceholderCompetition({ name, organizer: 1 }), true, name)
  }
})

test("dostartu's own test organizer and deleted rows are placeholders", () => {
  assert.equal(isPlaceholderCompetition({ name: 'sasdasd', organizer: 643 }), true)
  assert.equal(isPlaceholderCompetition({ name: 'Bieg Karpia', organizer: 1, deleted: true }), true)
})

test('real races are kept, a Cooper test included', () => {
  for (const name of [
    'Mały Memoriał Żylewicza - Amatorski Bieg na 3000 m',
    'SKL II Bieg na przywitanie Wakacji - Bieg Główny 5 km',
    'Test Coopera dla każdego',
    'Otwarty test Coopera',
    'Bieg Wąsaczy - Cancer Run 2026',
    'Protestancki Bieg Pokoju',
  ]) {
    assert.equal(isPlaceholderCompetition({ name, organizer: 1540, deleted: false }), false, name)
  }
})

test('unlistedCompetitions keeps real competitions the public listing did not return', () => {
  const panel = [
    { id: 100, name: 'Listed race', mainPromo: true },
    { id: 16402, name: 'Mały Memoriał Żylewicza', mainPromo: false, organizer: 1540 },
    { id: 16402, name: 'Mały Memoriał Żylewicza', mainPromo: false, organizer: 1540 },
    { id: 200, name: 'Already listed by id', mainPromo: false },
    { id: 300, name: 'Moje pierwsze zawody', mainPromo: false },
    { id: 400, name: 'Promoted after the public pass ran', mainPromo: true },
  ]
  const out = unlistedCompetitions(panel, new Set(['100', '200']))
  assert.deepEqual(out.map(ev => ev.id), [16402, 400])
})

test('white-label hosts are dostartu-like and their -v / -vc ids are read', () => {
  for (const host of WHITE_LABEL_HOSTS) {
    assert.equal(isDostartuLikeUrl(`https://${host}/x-v1`), true, host)
  }
  assert.equal(isDostartuLikeUrl('https://zapisy.inessport.pl/x-v1'), false)
  assert.equal(
    extractDostartuId('https://zapisy.domtel-sport.pl/maly-memorial-zylewicza-amatorski-bieg-na-3000-m-v16402'),
    '16402'
  )
  assert.equal(
    extractDostartuId('https://zapisy.domtel-sport.pl/skl-ii-bieg-na-przywitanie-wakacji-bieg-g-owny-5-km-vc16182'),
    '16182'
  )
  // "-cc<id>" is a cycle, not a competition.
  assert.equal(extractDostartuId('https://zapisy.mktime.pl/1-aktywna-piatka-cc7719'), null)
})
