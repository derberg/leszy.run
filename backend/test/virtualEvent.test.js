import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksVirtual } from '../src/lib/virtualEvent.js'

// Every row below was taken verbatim from calendar_events / scraper_all.

test('drops a race whose name says it is run virtually', () => {
  assert.equal(looksVirtual({ name: 'IX Bieg Anioła - wirtualnie', location: 'Cała Polska' }), true)
  assert.equal(looksVirtual({ name: 'Wirtualny Bieg Chocolate RUN', location: 'Polska' }), true)
  assert.equal(
    looksVirtual({ name: '4. HMT Bieg wirtualny – sierpień 2026 – Operacja Korona 1985-1988', location: 'Cały świat' }),
    true
  )
  assert.equal(
    looksVirtual({ name: 'Cykl biegów wirtualnych "Poznaj swoją małą ojczyznę"', location: 'Piastów' }),
    true
  )
  assert.equal(
    looksVirtual({ name: 'IX Krwiobieg Warszawa - wersja wirtualna - Idę - biegnę - wspieram', location: 'Cała Polska' }),
    true
  )
})

test('drops an English-named virtual challenge', () => {
  assert.equal(looksVirtual({ name: 'Rio de Janeiro Virtual Challange', location: 'Gdynia' }), true)
  assert.equal(looksVirtual({ name: 'Wild Run 2026 - bieg wirtualny', location: 'Świat' }), true)
})

test('keeps a hybrid that also has an on-site start', () => {
  // A real race in Gdańsk that additionally sells a virtual entry. The physical
  // edition is what the calendar is for, so the row must survive.
  assert.equal(
    looksVirtual({
      name: 'IX Bieg Charytatywny PÓŁNOCNY POMAGA – bieg wirtualny i stacjonarny',
      location: 'Gdańsk',
    }),
    false
  )
  assert.equal(
    looksVirtual({ name: 'Bieg Niepodległości - stacjonarnie i wirtualnie', location: 'Poznań' }),
    false
  )
})

test('a name that merely contains the letters is not evidence', () => {
  // No "wirtualn" stem, no standalone "virtual" word — these are ordinary races.
  assert.equal(looksVirtual({ name: 'Bieg Wirtuozów', location: 'Kraków' }), false)
  assert.equal(looksVirtual({ name: 'VirtualGym Cross', location: 'Łódź' }), false)
  assert.equal(looksVirtual({ name: 'XV Bieg Zdalny Serca', location: 'Zabrze' }), false)
})

test('an ordinary race is untouched', () => {
  assert.equal(looksVirtual({ name: 'Nocny Zew Wilka', location: 'Leszno' }), false)
  assert.equal(looksVirtual({}), false)
  assert.equal(looksVirtual(), false)
})
