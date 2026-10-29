import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runnerDataInfo } from '../../src/legal/runnerDataInfo.js'

const text = (info) => JSON.stringify(info)
const base = { eventName: 'Bieg Leszego', organizerName: 'ZATYRANI', contactEmail: 'biuro@zatyrani.pl' }

describe('runnerDataInfo (ruling P2-R21)', () => {
  it('fills the event, organizer and contact address', () => {
    const t = text(runnerDataInfo(base))
    assert.ok(t.includes('Bieg Leszego') && t.includes('ZATYRANI') && t.includes('biuro@zatyrani.pl'))
    assert.ok(t.includes('12 miesięcy'))
  })

  it('names the safeguard for processors in the USA', () => {
    assert.ok(text(runnerDataInfo(base)).includes('standardowe klauzule umowne Komisji Europejskiej lub EU-US Data Privacy Framework (art. 46 ust. 2 lit. c / art. 45 RODO)'))
  })

  it('a free individual event: no payment operator, no paid status, no team name', () => {
    const t = text(runnerDataInfo(base))
    for (const s of ['dpay', 'opłacone', 'nazwa drużyny', 'Dane o płatnościach', 'nie zostało opłacone']) assert.equal(t.includes(s), false, s)
  })

  it('a paid event with teams: all of them', () => {
    const t = text(runnerDataInfo({ ...base, paid: true, teams: true }))
    for (const s of ['dpay', 'opłacone', 'nazwa drużyny', 'Dane o płatnościach', 'nie zostało opłacone']) assert.ok(t.includes(s), s)
    const teamsOnly = text(runnerDataInfo({ ...base, teams: true }))
    assert.ok(teamsOnly.includes('nazwa drużyny'))
    assert.equal(teamsOnly.includes('dpay'), false)
  })

  it('W-64 nationality is named only when the event collects it, and never as published', () => {
    assert.equal(text(runnerDataInfo(base)).includes('narodowość'), false)
    const t = text(runnerDataInfo({ ...base, nationality: true }))
    assert.ok(t.includes('narodowość'))
    assert.ok(/numer telefonu, narodowość i dane osoby do kontaktu w nagłych wypadkach nie są publikowane/.test(t))
  })
})
