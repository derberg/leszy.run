import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distinguishingTags, hasDistinguishingConflict } from '../src/scrapers/dedup.js'

test('ultra is not a style, so a disagreement about it never blocks a merge', () => {
  // Measured on biegigorskie 2026-09-17: a mountain-only source tags the course
  // AND the distance, a generalist tags only the course, and the guard used to
  // read that richer knowledge as a conflict.
  const specialist = distinguishingTags({ name: 'XI Bieg Beskidnika', event_types: ['trail', 'ultra'] })
  const generalist = distinguishingTags({ name: 'XI Bieg Beskidnika', event_types: ['trail'] })
  assert.equal(hasDistinguishingConflict(specialist, generalist), false)
})

test('a name carrying the word ultra contributes no style tag', () => {
  // "Garmin Ultra Race Gdańsk" used to tag itself style:ultra from the name
  // alone, on whichever side read it, which is how two rows for one race ended
  // up with different style sets while agreeing about everything that matters.
  const a = distinguishingTags({ name: 'Garmin Ultra Race Gdańsk', event_types: ['uliczny', 'ultra'] })
  const b = distinguishingTags({ name: 'Garmin Ultra Race Gdańsk', event_types: ['trail', 'ultra'] })
  assert.equal([...a].some(t => t.startsWith('style:')), false)
  assert.deepEqual([...b].filter(t => t.startsWith('style:')), ['style:trail'])
  // One side now has no style information at all, and absence is not denial.
  assert.equal(hasDistinguishingConflict(a, b), false)
})

test('the styles that describe a course still guard the merge', () => {
  const trail = distinguishingTags({ name: 'Bieg Leśny', event_types: ['trail'] })
  const ocr = distinguishingTags({ name: 'Bieg Leśny', event_types: ['ocr'] })
  const nw = distinguishingTags({ name: 'Bieg Leśny', event_types: ['trail', 'nordic walking'] })
  assert.equal(hasDistinguishingConflict(trail, ocr), true)
  assert.equal(hasDistinguishingConflict(trail, nw), true)
})

test('kids, distance class and edition are untouched', () => {
  const kids = distinguishingTags({ name: 'Kamień Extreme Kids 2026' })
  const adult = distinguishingTags({ name: '21. Kamień Extreme' })
  assert.equal(hasDistinguishingConflict(kids, adult), true)
  const half = distinguishingTags({ name: 'Półmaraton Ślężański' })
  const full = distinguishingTags({ name: 'Maraton Ślężański' })
  assert.equal(hasDistinguishingConflict(half, full), true)
})
