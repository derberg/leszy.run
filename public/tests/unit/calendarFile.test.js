import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { icsFor } from '../../src/lib/calendarFile.js'

const lines = (s) => s.split('\r\n')

describe('icsFor („Dodaj do kalendarza”)', () => {
  it('a timed start: Warsaw local time as UTC, two hours, place and page link', () => {
    const ics = icsFor({
      uid: 'reg-1', title: 'Bieg Leszego, Nordic walking 9 km', eventDate: '2026-12-06', startTime: '10:10',
      location: 'Nieborowice, Boisko przy szkole', url: 'https://www.leszy.run/events/bieg-leszego', now: new Date('2026-11-06T10:00:00Z'),
    })
    const l = lines(ics)
    assert.equal(l[0], 'BEGIN:VCALENDAR')
    assert.ok(l.includes('UID:reg-1@leszy.run'))
    assert.ok(l.includes('DTSTAMP:20261106T100000Z'))
    assert.ok(l.includes('DTSTART:20261206T091000Z'), 'CET is UTC+1')
    assert.ok(l.includes('DTEND:20261206T111000Z'))
    assert.ok(l.includes('SUMMARY:Bieg Leszego\\, Nordic walking 9 km'))
    assert.ok(l.includes('LOCATION:Nieborowice\\, Boisko przy szkole'))
    assert.ok(l.includes('URL:https://www.leszy.run/events/bieg-leszego'))
    assert.equal(l.at(-2), 'END:VCALENDAR')
    assert.equal(l.at(-1), '')
  })

  it('summer time is UTC+2; no start time makes an all-day entry', () => {
    const summer = lines(icsFor({ uid: 'a', title: 'X', eventDate: '2026-06-14', startTime: '09:00', now: new Date(0) }))
    assert.ok(summer.includes('DTSTART:20260614T070000Z'))
    const allDay = lines(icsFor({ uid: 'b', title: 'X', eventDate: '2026-06-14', startTime: null, now: new Date(0) }))
    assert.ok(allDay.includes('DTSTART;VALUE=DATE:20260614'))
    assert.ok(allDay.includes('DTEND;VALUE=DATE:20260615'))
  })
})

describe('icsFor across the Warsaw clock changes', () => {
  const start = (eventDate, startTime) => lines(icsFor({ uid: 'x', title: 'X', eventDate, startTime, now: new Date(0) }))
    .find((l) => l.startsWith('DTSTART'))

  it('2026-10-25 (CEST → CET at 03:00): 10:00 is 09:00 UTC', () => {
    assert.equal(start('2026-10-25', '10:00'), 'DTSTART:20261025T090000Z')
  })

  it('2027-03-28 (CET → CEST at 02:00): 10:00 is 08:00 UTC', () => {
    assert.equal(start('2027-03-28', '10:00'), 'DTSTART:20270328T080000Z')
  })

  it('an ordinary winter and summer day', () => {
    assert.equal(start('2026-12-06', '10:00'), 'DTSTART:20261206T090000Z')
    assert.equal(start('2026-07-05', '10:00'), 'DTSTART:20260705T080000Z')
  })
})

describe('icsFor text escaping (RFC 5545 §3.3.11)', () => {
  it('backslash, semicolon, comma and line breaks are escaped', () => {
    const l = lines(icsFor({ uid: 'x', title: 'A;B,C\\D\nE', eventDate: '2026-12-06', startTime: null, location: 'Sala; 2, piętro', now: new Date(0) }))
    assert.ok(l.includes('SUMMARY:A\\;B\\,C\\\\D\\nE'), l.join('|'))
    assert.ok(l.includes('LOCATION:Sala\\; 2\\, piętro'))
  })
})

