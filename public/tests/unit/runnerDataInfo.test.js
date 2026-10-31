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

describe('runnerDataInfo start list (ruling P3-R14)', () => {
  it('a paid event: an unpaid entry is only a number, never a name', () => {
    const t = text(runnerDataInfo({ ...base, paid: true }))
    assert.ok(t.includes('Zgłoszenia czekające na wpłatę pokazujemy tylko jako liczbę, bez imienia i nazwiska.'))
    assert.equal(t.includes('informacja, czy zgłoszenie jest opłacone'), false)
  })

  it('every event: no town for a runner under 18', () => {
    for (const paid of [false, true]) {
      assert.ok(text(runnerDataInfo({ ...base, paid })).includes('Miejscowości osób niepełnoletnich nie publikujemy.'))
    }
  })

  it('the version moved past v2 with these lines', async () => {
    const { RUNNER_DATA_INFO_VERSION } = await import('../../src/legal/runnerDataInfo.js')
    assert.ok(!['2026-11-v1', '2026-11-v2'].includes(RUNNER_DATA_INFO_VERSION))
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

describe('runnerDataInfo image publication (P2-R33, reviews U1 I1 and U2 I1)', () => {
  const table = () => runnerDataInfo(base).sections.find((s) => s.heading === 'Po co i na jakiej podstawie').blocks[0].table

  it('the name and the result in the results lists rest on the contract', () => {
    const row = table().find(([cel]) => cel.includes('imię, nazwisko i wynik na listach wyników'))
    assert.ok(row)
    assert.equal(row[1], 'art. 6 ust. 1 lit. b RODO (umowa)')
  })

  it('photo and video reports rest on legitimate interest alone, with the right to object', () => {
    const row = table().find(([cel]) => cel.includes('Zdjęcia i nagrania wideo'))
    assert.ok(row)
    assert.match(row[1], /^art\. 6 ust\. 1 lit\. f RODO/)
    assert.match(row[1], /art\. 21 RODO/)
    assert.doesNotMatch(row[1], /lit\. [abd]\b/)
  })

  it('the image rests on the regulamin permission under art. 81 ust. 1, crowd shots on ust. 2 pkt 2, and it is not GDPR consent', () => {
    const published = JSON.stringify(runnerDataInfo(base).sections.find((s) => s.heading === 'Co jest publikowane'))
    assert.ok(published.includes('art. 81 ust. 1 ustawy o prawie autorskim i prawach pokrewnych'))
    assert.ok(published.includes('art. 81 ust. 2 pkt 2'))
    assert.ok(published.includes('nie jest zgodą w rozumieniu RODO'))
    assert.ok(published.includes('art. 6 ust. 1 lit. f RODO') && published.includes('art. 21 RODO'))
    assert.doesNotMatch(published, /a nie zgoda/)
  })

  it('the retention line is shown to runners without a verification marker', () => {
    const t = JSON.stringify(runnerDataInfo(base))
    assert.ok(t.includes('Zdjęcia i nagrania z zawodów'))
    assert.doesNotMatch(t, /WERYFIKACJI|weryfikacji/)
  })

  it('the source document carries the same rows and the same image paragraph', async () => {
    const { readFile } = await import('node:fs/promises')
    const md = await readFile(new URL('../../../docs/legal/zapisy/informacja-o-danych-zawodnika.md', import.meta.url), 'utf8')
    for (const [cel, basis] of table().filter(([c]) => c.includes('wyników') || c.includes('Zdjęcia'))) {
      assert.ok(md.includes(`| ${cel} | ${basis} |`), cel)
    }
    const published = runnerDataInfo(base).sections.find((s) => s.heading === 'Co jest publikowane').blocks[1]
    assert.ok(md.includes(published))
  })
})

describe('runnerDataInfo group registration (Plan 4, task 8)', () => {
  const section = () => runnerDataInfo(base).sections.find((s) => s.heading === 'Gdy zapisujesz inną osobę')

  it('names the person who registered an added adult as the source of the data (Art. 14(2)(f))', () => {
    assert.ok(section(), 'the section is shown to runners')
    const t = JSON.stringify(section())
    assert.ok(t.includes('art. 14 ust. 2 lit. f RODO'))
    assert.ok(t.includes('podajemy Twoje imię i nazwisko jako osoby, która ją zapisała'))
  })

  it('describes the consent link: the code, the data to check, the regulamin, the reminders, the office', () => {
    const t = JSON.stringify(section())
    for (const s of ['kod', 'poprawić swoje dane', 'akceptuje regulamin', 'przypomnienie', 'unieważnia poprzedni link', 'w biurze zawodów',
      'nie pokazujemy jej na publicznej liście startowej z imienia i nazwiska']) assert.ok(t.includes(s), s)
  })

  it('a child is registered by the guardian and gets no message; a deleted guardian leaves the entry', () => {
    const t = JSON.stringify(section())
    assert.ok(t.includes('Dziecko nie dostaje od LESZY.RUN żadnych wiadomości.'))
    assert.ok(t.includes('Jeżeli opiekun usunie konto LESZY.RUN, zgłoszenie dziecka zostaje'))
  })

  it('the start list names gender among what is published', () => {
    const published = JSON.stringify(runnerDataInfo(base).sections.find((s) => s.heading === 'Co jest publikowane'))
    assert.ok(published.includes('płeć'))
  })

  it('the source document carries the same section, word for word', async () => {
    const { readFile } = await import('node:fs/promises')
    const md = await readFile(new URL('../../../docs/legal/zapisy/informacja-o-danych-zawodnika.md', import.meta.url), 'utf8')
    for (const block of section().blocks) assert.ok(md.includes(block), block.slice(0, 60))
  })

  it('the version moved past v3 with the section', async () => {
    const { RUNNER_DATA_INFO_VERSION } = await import('../../src/legal/runnerDataInfo.js')
    assert.notEqual(RUNNER_DATA_INFO_VERSION, '2026-11-v3')
  })
})
