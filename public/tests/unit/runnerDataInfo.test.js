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

describe('runnerDataInfo version', () => {
  it('matches the „Wersja” of the source document, and moved past v1 with the nationality line', async () => {
    const { readFile } = await import('node:fs/promises')
    const { RUNNER_DATA_INFO_VERSION } = await import('../../src/legal/runnerDataInfo.js')
    const md = await readFile(new URL('../../../docs/legal/zapisy/informacja-o-danych-zawodnika.md', import.meta.url), 'utf8')
    assert.equal(md.match(/\*\*Wersja:\*\* (\S+)/)[1], RUNNER_DATA_INFO_VERSION)
    assert.notEqual(RUNNER_DATA_INFO_VERSION, '2026-11-v1')
  })
})

describe('runnerDataInfo image publication (P2-R33, review I1)', () => {
  it('names the purpose, the contract and legitimate-interest basis, art. 81, the right to object and the retention; never calls it consent', () => {
    const info = runnerDataInfo(base)
    const table = info.sections.find((s) => s.heading === 'Po co i na jakiej podstawie').blocks[0].table
    const row = table.find(([cel]) => cel.includes('wizerunku'))
    assert.ok(row, 'an image row in the purposes table')
    assert.match(row[1], /art\. 6 ust\. 1 lit\. b RODO/)
    assert.match(row[1], /art\. 6 ust\. 1 lit\. f RODO/)
    assert.match(row[1], /art\. 81 ustawy o prawie autorskim/)
    assert.doesNotMatch(row[1], /lit\. a|zgod/)
    const published = JSON.stringify(info.sections.find((s) => s.heading === 'Co jest publikowane'))
    assert.ok(published.includes('wizerunek (zdjęcia, wideo)') && published.includes('a nie zgoda') && published.includes('art. 21 RODO'))
    assert.ok(JSON.stringify(info.sections.find((s) => s.heading === 'Jak długo')).includes('Zdjęcia i nagrania z zawodów'))
  })

  it('the source document carries the same image row', async () => {
    const { readFile } = await import('node:fs/promises')
    const md = await readFile(new URL('../../../docs/legal/zapisy/informacja-o-danych-zawodnika.md', import.meta.url), 'utf8')
    const [cel, basis] = runnerDataInfo(base).sections[1].blocks[0].table.find(([c]) => c.includes('wizerunku'))
    assert.ok(md.includes(`| ${cel} | ${basis} |`))
  })
})
