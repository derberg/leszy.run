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
