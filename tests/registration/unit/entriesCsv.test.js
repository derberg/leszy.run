import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { entriesToCsv } from '../../../supabase/functions/_shared/registration/entriesCsv.js'

const HEADER = 'Nr;Imię;Nazwisko;Data urodzenia;Płeć;Kategoria;Konkurencja;Drużyna;Klub;Miejscowość;Narodowość;E-mail;Telefon;Kontakt ICE;Telefon ICE;Opiekun;E-mail opiekuna;Status;Wpłata (zł);Zwrócono (zł);Regulamin;Partner;Data zapisu'
const quotedHeader = HEADER.split(';').map((h) => `"${h}"`).join(';')

const ROW = {
  bib: 214, firstName: 'Anna', lastName: 'Wiśniewska', birthDate: '1990-05-01', gender: 'K',
  ageGroupLabel: 'K30–39', competition: 'Bieg 9 km', team: { name: 'Leśne Dziki' }, club: 'ZATYRANI', city: 'Zabrze',
  nationality: 'PL', email: 'anna@example.pl', phone: '500600700', iceName: 'Jan', icePhone: '500600701',
  guardianName: null, guardianEmail: null, statusKey: 'paid', status: 'confirmed', role: 'self', consentState: 'accepted',
  paidAmount: 6050, refunded: 0, refundUnconfirmed: 0, partnerName: null, createdAt: '2026-10-20T22:30:00Z',
}
const cellsOf = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1])

describe('entriesToCsv (O-04)', () => {
  it('starts with the BOM and the exact header, every cell quoted', () => {
    const csv = entriesToCsv([])
    assert.equal(csv, `﻿${quotedHeader}`)
  })

  it('writes one CRLF line per row in the header order', () => {
    const lines = entriesToCsv([ROW]).slice(1).split('\r\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(cellsOf(lines[1]), [
      '214', 'Anna', 'Wiśniewska', '1990-05-01', 'K', 'K30–39', 'Bieg 9 km', 'Leśne Dziki', 'ZATYRANI', 'Zabrze', 'PL',
      'anna@example.pl', '500600700', 'Jan', '500600701', '', '', 'OPŁACONE', '60,50', '0,00', 'zaakceptowany', '',
      '2026-10-21 00:30',
    ])
  })

  it('neutralises every formula opener', () => {
    for (const bad of ['=SUM(A1)', '+48500600700', '-1+2', '@cmd', '\tx', '\rx', ' =SUM(A1)']) {
      const line = entriesToCsv([{ ...ROW, club: bad }]).split('\r\n').at(-1)
      assert.ok(line.includes(`"'${bad}"`), JSON.stringify(bad))
    }
    assert.equal(cellsOf(entriesToCsv([{ ...ROW, club: '=SUM(A1)' }]).split('\r\n').at(-1))[8], "'=SUM(A1)")
  })

  it('neutralises a name, a team and a phone as well as a club', () => {
    const line = entriesToCsv([{ ...ROW, firstName: '=A', lastName: '@B', team: { name: '+C' }, phone: '+48500' }]).split('\r\n').at(-1)
    const cells = cellsOf(line)
    assert.deepEqual([cells[1], cells[2], cells[7], cells[12]], ["'=A", "'@B", "'+C", "'+48500"])
  })

  it('doubles quotes and keeps a separator and a newline inside the quotes', () => {
    const csv = entriesToCsv([{ ...ROW, club: 'a;b"c', city: 'x\ny' }])
    assert.ok(csv.includes('"a;b""c"'))
    assert.ok(csv.includes('"x\ny"'))
  })

  it('writes grosze as Polish złoty, digit by digit', () => {
    const cell = (paidAmount) => cellsOf(entriesToCsv([{ ...ROW, paidAmount }]).split('\r\n').at(-1))[18]
    assert.equal(cell(6000), '60,00')
    assert.equal(cell(6050), '60,50')
    assert.equal(cell(5), '0,05')
    assert.equal(cell(0), '0,00')
    assert.equal(cell(null), '')
  })

  it('counts as returned only what dpay accepted', () => {
    const cells = cellsOf(entriesToCsv([{ ...ROW, statusKey: 'refund_unconfirmed', paidAmount: 6000, refunded: 3000, refundUnconfirmed: 1000 }]).split('\r\n').at(-1))
    assert.equal(cells[19], '20,00')
  })

  it('leaves an unset value empty and states the regulamin the way the panel does', () => {
    const cells = cellsOf(entriesToCsv([{
      firstName: 'Ola', lastName: 'Mała', statusKey: 'awaiting', status: 'pending_payment', role: 'minor', consentState: 'accepted',
      guardianName: 'Ewa', guardianEmail: 'ewa@example.pl', expiresAt: '2026-11-04T22:59:00Z',
    }]).split('\r\n').at(-1))
    assert.equal(cells[0], '')
    assert.equal(cells[7], '')
    assert.deepEqual([cells[15], cells[16]], ['Ewa', 'ewa@example.pl'])
    assert.equal(cells[17], 'CZEKA NA WPŁATĘ · DO 4.11')
    assert.equal(cells[20], 'opiekun')
    const regulamin = (over) => cellsOf(entriesToCsv([{ ...ROW, ...over }]).split('\r\n').at(-1))[20]
    assert.equal(regulamin({ consentState: 'awaiting' }), 'czeka na zgodę')
    assert.equal(regulamin({ consentState: 'office' }), 'podpisany w biurze')
    assert.equal(regulamin({ status: 'cancelled', statusKey: 'cancelled' }), '')
  })
})
