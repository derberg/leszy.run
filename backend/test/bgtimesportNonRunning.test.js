import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNonRunningEvent } from '../src/scrapers/sources/bgtimesport.js'

test('a ski mountaineering event is dropped by its race headings', () => {
  // bgtimesport 892: the name says SKITUR, the races say skialpinizm.
  assert.equal(isNonRunningEvent('ZŁOTY GROŃ ATAK 2026', ['Gigant - Puchar Polski w skialpinizmie']), true)
  assert.equal(isNonRunningEvent('ZŁOTY GROŃ SKITUR ATAK 2026', []), true)
})

test('biathlon, pumptrack and MTB events are dropped by name', () => {
  for (const name of [
    'Biathlon dla Każdego Brenna',
    'Regionalne Zawody Biathlonowe',
    'FINAŁ PUCHARU W BIATHLONIE LETNIM',
    'Pumptrackowy Puchar Brennej vol. 14',
    'PUCHAR BATUSIA MTB 2026',
  ]) assert.equal(isNonRunningEvent(name, []), true, name)
})

test('a mountain run is kept', () => {
  assert.equal(isNonRunningEvent('Bieg na Klimczok', ['Bieg główny 12 km', 'Bieg dzieci']), false)
})
