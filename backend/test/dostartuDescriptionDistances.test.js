import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrape, parseClassifications, distancesFromDescription } from '../src/scrapers/sources/dostartu.js'

// Competition 17484 (XVIII BIEG NIEPODLEGŁOŚCI - Biegi Dzieci, 2026-11-11) has one
// classification "Biegi Dzieci" with distance 0. The distances live only in
// descriptionPl. Text below is that description as served on 2026-10-19,
// including the missing space in "dystansie1500 m".
const DESCRIPTION_17484 = `Kategorie Wiekowe:
<br>
1) Rocznik 2020 i młodsi (przedszkole) dziewczynki na dystansie 250 m,
2) Rocznik 2020 i młodsi (przedszkole) chłopcy na dystansie 250 m,
3) Rocznik 2018-2019 dziewczynki na dystansie 350 m,
4) Rocznik 2018-2019 chłopcy na dystansie 350 m,
5) Rocznik 2016-2017 dziewczynki na dystansie 500 m,
6) Rocznik 2016-2017 chłopcy na dystansie 500 m,
7) Rocznik 2014-2015 dziewczynki na dystansie 1000 m,
8) Rocznik 2014-2015 chłopcy na dystansie 1000 m,
9) Rocznik 2012-2013 dziewczynki na dystansie1500 m,
10) Rocznik 2012-2013 chłopcy na dystansie 1500 m.`

test('17484: classifications alone give no distances', () => {
  const { distances } = parseClassifications(
    [{ namePl: 'Biegi Dzieci', distance: 0, classificationSetting: { playerType: 'kids' } }],
    'XVIII BIEG NIEPODLEGŁOŚCI - Biegi Dzieci',
  )
  assert.equal(distances, '')
})

test('17484: distances are read from descriptionPl', () => {
  assert.equal(distancesFromDescription(DESCRIPTION_17484), '250m, 350m, 500m, 1 km, 1.5 km')
})

test('km distances in a description keep the km label', () => {
  assert.equal(distancesFromDescription('Bieg na dystansie 10 km i dystans 5,5 km'), '10 km, 5.5 km')
})

test('empty or missing description gives empty string', () => {
  assert.equal(distancesFromDescription(null), '')
  assert.equal(distancesFromDescription('Zapraszamy na bieg!'), '')
})

test('thousands space and Polish inflections are read', () => {
  assert.equal(distancesFromDescription('na dystansie 1 500 m oraz dystansów 5 km'), '1.5 km, 5 km')
})

// scrape() end to end with a mocked API: the list item carries descriptionPl
// (checked live on 2026-10-19), and distances must come out of it.
async function scrapeWith(listItem, classifications) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    const body = u.includes('/classifications')
      ? { classifications }
      : { competitions: u.includes('page=1') ? [listItem] : [] }
    return { ok: true, json: async () => body }
  }
  try {
    return await scrape()
  } finally {
    globalThis.fetch = realFetch
  }
}

test('scrape(): kids event takes distances from the list item descriptionPl', async () => {
  const [row] = await scrapeWith(
    { id: 17484, name: 'XVIII BIEG NIEPODLEGŁOŚCI - Biegi Dzieci', startedTime: '2026-11-11T10:00:00', descriptionPl: DESCRIPTION_17484 },
    [{ namePl: 'Biegi Dzieci', distance: 0, classificationSetting: { playerType: 'kids' } }],
  )
  assert.equal(row.distances, '250m, 350m, 500m, 1 km, 1.5 km')
})

test('scrape(): mixed adult+kids event does not take kids distances from the description', async () => {
  const [row] = await scrapeWith(
    {
      id: 1, name: 'Bieg Leśny', startedTime: '2026-11-11T10:00:00',
      descriptionPl: 'Bieg główny. Dystans dla dzieci 400 m. Na dystansie 21 km przewyższenie 300 m.',
    },
    [
      { namePl: 'Open', distance: 0 },
      { namePl: 'Bieg dzieci', distance: 0, classificationSetting: { playerType: 'kids' } },
    ],
  )
  assert.equal(row.distances, '')
})
