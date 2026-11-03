import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { entriesToCsv, vouchersToCsv } from '../../../supabase/functions/_shared/registration/entriesCsv.js'

const HEADER = 'Nr;Imię;Nazwisko;Data urodzenia;Płeć;Kategoria;Konkurencja;Drużyna;Klub;Miejscowość;Narodowość;E-mail;Telefon;Kontakt ICE;Telefon ICE;Opiekun;E-mail opiekuna;Status;Wpłata (zł);Zwrócono (zł);Regulamin;Partner;Kod rabatowy;Data zapisu;Brak danych'
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
      'anna@example.pl', '500600700', 'Jan', '500600701', '', '', 'OPŁACONE', '60,50', '0,00', 'zaakceptowany', '', '',
      '2026-10-21 00:30', '',
    ])
  })

  it('names what a team member still owes, and a member with no phone yet exports', () => {
    const owing = { ...ROW, phone: null, club: null, iceName: null, icePhone: null, missingFields: ['phone', 'iceName', 'icePhone'] }
    const cells = cellsOf(entriesToCsv([owing]).split('\r\n').at(-1))
    assert.equal(cells.at(-1), 'telefon, kontakt ICE')
    assert.equal(cells[12], '')
  })

  it('neutralises every formula opener', () => {
    for (const bad of ['=SUM(A1)', '+48500600700', '-1+2', '@cmd', '\tx', '\rx', ' =SUM(A1)']) {
      const line = entriesToCsv([{ ...ROW, club: bad }]).split('\r\n').at(-1)
      assert.ok(line.includes(`"'${bad}"`), JSON.stringify(bad))
    }
    assert.equal(cellsOf(entriesToCsv([{ ...ROW, club: '=SUM(A1)' }]).split('\r\n').at(-1))[8], "'=SUM(A1)")
  })

  it('neutralises a name, a team and a phone as well as a club', () => {
    const line = entriesToCsv([{ ...ROW, firstName: '=A', lastName: '@B', team: { name: '+C' }, phone: '-1+A1' }]).split('\r\n').at(-1)
    const cells = cellsOf(line)
    assert.deepEqual([cells[1], cells[2], cells[7], cells[12]], ["'=A", "'@B", "'+C", "'-1+A1"])
  })

  it('leaves a real phone usable in Telefon and Telefon ICE (F1)', () => {
    const cells = cellsOf(entriesToCsv([{ ...ROW, phone: '+48 600 100 200', icePhone: '+48600100201' }]).split('\r\n').at(-1))
    assert.deepEqual([cells[12], cells[14]], ['+48 600 100 200', '+48600100201'])
  })

  it('exempts only `+`, a digit, then digits and spaces (the ledger ruling, final review M3)', () => {
    for (const bad of ['-2-3', '-600 100 200', '+48 (600) 100-201', '+ 48 600', '+48-600-100']) {
      const cells = cellsOf(entriesToCsv([{ ...ROW, phone: bad, icePhone: bad }]).split('\r\n').at(-1))
      assert.deepEqual([cells[12], cells[14]], [`'${bad}`, `'${bad}`], bad)
    }
  })

  it('still guards a phone column holding anything but phone characters (F1)', () => {
    const cells = cellsOf(entriesToCsv([{ ...ROW, phone: '+48+SUM(A1)', icePhone: '=1+2' }]).split('\r\n').at(-1))
    assert.deepEqual([cells[12], cells[14]], ["'+48+SUM(A1)", "'=1+2"])
    assert.equal(cellsOf(entriesToCsv([{ ...ROW, club: '+48 600 100 200' }]).split('\r\n').at(-1))[8], "'+48 600 100 200")
  })

  it('never writes a negative refund, and does not fail the export (F4)', () => {
    const cells = cellsOf(entriesToCsv([{ ...ROW, refunded: 1000, refundUnconfirmed: 3000 }]).split('\r\n').at(-1))
    assert.equal(cells[19], '0,00')
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
    // A child whose parent is not the captain waits for that parent (TP), and their paper consent reads so.
    assert.equal(regulamin({ role: 'minor', consentState: 'awaiting' }), 'czeka na zgodę opiekuna')
    assert.equal(regulamin({ role: 'minor', consentState: 'office' }), 'zgoda opiekuna na papierze')
    assert.equal(regulamin({ status: 'cancelled', statusKey: 'cancelled' }), '')
  })
})

describe('Partner and Kod rabatowy (Plan 7, V-34)', () => {
  it('fills both from the row, and escapes a partner named like a formula', () => {
    const cells = cellsOf(entriesToCsv([{ ...ROW, partnerName: 'Sklep Biegacz', voucherCode: 'BIEGACZ15' }]).split('\r\n').at(-1))
    assert.deepEqual([cells[21], cells[22]], ['Sklep Biegacz', 'BIEGACZ15'])
    const bad = cellsOf(entriesToCsv([{ ...ROW, partnerName: '=HYPERLINK(1)', voucherCode: '-ABC' }]).split('\r\n').at(-1))
    assert.deepEqual([bad[21], bad[22]], ["'=HYPERLINK(1)", "'-ABC"])
  })
})

describe('vouchersToCsv (Plan 7, organizer-vouchers export)', () => {
  const V = { code: 'BIEGACZ15', percent: 15, used: 3, maxUses: 10, validUntil: '2026-11-30', partner: { id: 'p', name: 'Sklep' }, note: 'ulotki' }

  it('starts with the BOM and the header, one CRLF line per code', () => {
    const csv = vouchersToCsv([V])
    assert.ok(csv.startsWith('\uFEFF"Kod";"Rabat";"Wykorzystano";"Limit";"Ważny do";"Partner";"Notatka"\r\n'))
    assert.deepEqual(cellsOf(csv.split('\r\n')[1]), ['BIEGACZ15', '15%', '3', '10', '2026-11-30', 'Sklep', 'ulotki'])
  })

  it('leaves an open code, no partner and no note empty, and escapes a partner or note formula', () => {
    const cells = cellsOf(vouchersToCsv([{ ...V, validUntil: null, partner: null, note: null }]).split('\r\n')[1])
    assert.deepEqual(cells.slice(4), ['', '', ''])
    const bad = cellsOf(vouchersToCsv([{ ...V, partner: { name: '=HYPERLINK(1)' }, note: '@cmd' }]).split('\r\n')[1])
    assert.deepEqual(bad.slice(5), ["'=HYPERLINK(1)", "'@cmd"])
  })
})
