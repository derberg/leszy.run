import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wakesSnoozed } from '../src/lib/calendarSnooze.js'

const snoozed = {
  snoozed_at: '2026-11-26T12:00:00Z',
  registration_url: null,
  distances: [],
  price_from: 60,
  date: '2027-05-23',
}

test('a sign-up link where there was none brings the event back', () => {
  assert.equal(wakesSnoozed(snoozed, { registration_url: 'https://zapisy.example/1' }), true)
})

test('distances where the list was empty bring the event back', () => {
  assert.equal(wakesSnoozed(snoozed, { distances: ['10 km'] }), true)
})

test('a changed value the row already had does not', () => {
  assert.equal(wakesSnoozed(snoozed, { price_from: 70, last_verified_at: 'now' }), false)
})

test('a date move does not', () => {
  assert.equal(wakesSnoozed(snoozed, { date: '2027-05-30' }), false)
})

test('an event that is not snoozed is never woken', () => {
  assert.equal(wakesSnoozed({ ...snoozed, snoozed_at: null }, { registration_url: 'https://x.example' }), false)
})

test('a geocode or a source link alone does not', () => {
  assert.equal(wakesSnoozed({ ...snoozed, lat: null, source_links: [] }, { lat: 51.8, lng: 16.7, source_links: [{ source: 'x' }] }), false)
})
