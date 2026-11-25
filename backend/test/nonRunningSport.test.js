import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksNonRunningSport } from '../src/lib/nonRunningSport.js'

test('ski events are dropped in their declined Polish forms', () => {
  for (const name of [
    '51. Bieg Piastów – Festiwal Narciarstwa Biegowego - 15 km FT',
    'Charytatywny Bieg Narciarski dla Filipka Janasa',
    '23. Mistrzostwa Gminy Włoszakowice w Narciarstwie Alpejskim i Snowboardzie',
    'LETNI CHALLENGE NARCIARSKI 2026 - EDYCJA VII',
    'Puchar Narciarskiej Ligi',
    'ZŁOTY GROŃ SKITUR ATAK 2026',
    'Zawody Ski-Tour Beskidy',
    'Gigant - Puchar Polski w skialpinizmie',
    'Skimo Sprint',
    'Skiroll Cup',
  ]) assert.equal(looksNonRunningSport(name), true, name)
})

test('pumptrack and off-road motor events are dropped', () => {
  for (const name of [
    'Pumptrackowy Puchar Brennej vol. 14',
    'Pump Track Challenge',
    'Off-road Mazury',
    'Rajd OFFROAD Bory',
    'Zlot 4x4 Roztocze',
    'Zawody QUAD i ATV',
    '15 Terenowa Integracja Dla Choinki Zamość 2026',
  ]) assert.equal(looksNonRunningSport(name), true, name)
})

test('running races that only look alike are kept', () => {
  for (const name of [
    'Bieg Quadrans Kraków',
    'Sztafeta 4x400 m',
    'Bieg Kwadrat',
    'Bieg Leśny Ski-Hill Trail',
    'Bieg ulicą Skierniewicką',
    'Bieg Niepodległości',
    'Tropem Wilczym',
  ]) assert.equal(looksNonRunningSport(name), false, name)
})

test('any of the texts may carry the word', () => {
  assert.equal(looksNonRunningSport('ZŁOTY GROŃ 2026', 'Gigant - Puchar Polski w skialpinizmie'), true)
  assert.equal(looksNonRunningSport(null, undefined, ''), false)
})
