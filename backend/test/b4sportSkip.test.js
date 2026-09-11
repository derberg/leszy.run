import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNonRunningEvent, registrationSlugWords } from '../src/scrapers/sources/b4sport.js'

const B = 'https://b4sportonline.pl'

test('a brevet is dropped even when its name says nothing about cycling', () => {
  // KBR Kórnik registered its Brevet Niepodległa under a name no keyword reaches.
  assert.equal(
    isNonRunningEvent(
      'Rajd piastowski z okazji Święta Niepodległości',
      `${B}/Bractwo/zapisy_na_brevet_niepodlegla/5055`,
    ),
    true,
  )
})

test('a declined Polish cycling word is dropped', () => {
  // "Rowerowej", not "rowerowa": the stem has to run to the end of the word.
  assert.equal(
    isNonRunningEvent(
      'Festiwal Turystyki Rowerowej ,,Roztocze bez granic"',
      `${B}/roztocze_bez_granic/zapisy_na_rowerowe_lato_na_roztoczu/11891`,
    ),
    true,
  )
  assert.equal(isNonRunningEvent('Maraton kolarskiej pasji', `${B}/x/zapisy_na_maraton/1`), true)
})

test('a cycling slug is dropped under an innocent name', () => {
  assert.equal(
    isNonRunningEvent('Nocny Rajd do Torunia', `${B}/bydgoska_masa_krytyczna/zapisy_na_rajd_rowerowy_politechniki_bydgoskiej/12668`),
    true,
  )
})

test('a walking rajd is kept', () => {
  // Bare "rajd" is not a cycling word. These are the events the filter must not eat.
  assert.equal(
    isNonRunningEvent('IX Bieszczadzki Rajd Pieszy Edycja Natchnieni Bieszczadem 2026', `${B}/maraton_pieszy/zapisy_na_47_km__ix_brp_7/11965`),
    false,
  )
  assert.equal(
    isNonRunningEvent('IV Rajd Izersko – Karkonoski im. Roberta Kapczyńskiego', `${B}/rajd_izerskokarkonoski/zapisy_na_90km_trasa_piotrowa/11901`),
    false,
  )
})

test('ordinary running events are kept', () => {
  assert.equal(isNonRunningEvent('PKO Białystok Półmaraton', `${B}/pko_bialystok_polmaraton/zapisy_na_pko_bialystok_polmaraton_2/11250`), false)
  assert.equal(isNonRunningEvent('Letnie Mile Biegowe', `${B}/Biegi_Koszalin_2016/zapisy_na_letnie_mile_biegowe_2026/13036`), false)
})

test('the organizer segment is never read', () => {
  // A club named for cycling can still host a running race, and one keyword in
  // its slug would otherwise drop every event it lists.
  assert.equal(isNonRunningEvent('Bieg Wiosenny', `${B}/bike_team_krakow/zapisy_na_bieg_wiosenny/999`), false)
  assert.equal(registrationSlugWords(`${B}/bike_team_krakow/zapisy_na_bieg_wiosenny/999`), 'zapisy na bieg wiosenny')
})

test('registrationSlugWords turns separators into word boundaries', () => {
  // Underscores are word characters, so \b would never see "brevet" without this.
  assert.equal(
    registrationSlugWords(`${B}/Bractwo/zapisy_na_brevet_niepodlegla/5055`),
    'zapisy na brevet niepodlegla',
  )
})

test('registrationSlugWords survives a URL with no event segment', () => {
  assert.equal(registrationSlugWords(`${B}/onlyorg`), '')
  assert.equal(registrationSlugWords('not a url'), '')
  assert.equal(registrationSlugWords(null), '')
})
