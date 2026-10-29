import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  warsawToday, warsawDayStart, warsawDayAfter, registrationWindow, isOpen, daysLeft,
} from '../../../supabase/functions/_shared/registration/dates.js'

test('W-03 Warsaw day boundaries', () => {
  assert.equal(warsawDayAfter('2026-12-01').toISOString(), '2026-12-01T23:00:00.000Z')
  assert.equal(warsawDayStart('2026-10-25').toISOString(), '2026-10-24T22:00:00.000Z')
  assert.equal(warsawDayAfter('2026-10-25').toISOString(), '2026-10-25T23:00:00.000Z')
  assert.equal(warsawDayStart('2026-03-29').toISOString(), '2026-03-28T23:00:00.000Z')
  assert.equal(warsawDayAfter('2026-03-29').toISOString(), '2026-03-29T22:00:00.000Z')
})

test('W-03 registrationWindow is start of opens day and start of day after closes', () => {
  const w = registrationWindow({ opensOn: '2026-12-01', closesOn: '2026-12-01' })
  assert.equal(w.opensAt.toISOString(), '2026-11-30T23:00:00.000Z')
  assert.equal(w.closesAt.toISOString(), '2026-12-01T23:00:00.000Z')
})

test('W-03 isOpen at the exclusive closing instant', () => {
  const w = registrationWindow({ opensOn: '2026-11-01', closesOn: '2026-12-01' })
  assert.equal(isOpen(w, new Date('2026-12-01T22:59:59.999Z')), 'open')
  assert.equal(isOpen(w, new Date('2026-12-01T23:00:00.000Z')), 'closed')
  assert.equal(isOpen(w, new Date('2026-10-31T22:59:59.999Z')), 'not_yet')
  assert.equal(isOpen(w, new Date('2026-10-31T23:00:00.000Z')), 'open')
})

test('W-03 daysLeft and warsawToday', () => {
  const closesAt = warsawDayAfter('2026-12-01')
  // 23:30 Warsaw on 30.11 = 22:30Z
  assert.equal(daysLeft(closesAt, new Date('2026-11-30T22:30:00Z')), 1)
  assert.equal(daysLeft(closesAt, new Date('2026-12-02T10:00:00Z')), 0)
  assert.equal(warsawToday(new Date('2026-12-01T23:30:00Z')), '2026-12-02')
  assert.equal(warsawToday(new Date('2026-12-01T22:30:00Z')), '2026-12-01')
})
