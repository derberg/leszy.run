import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { buildExtrasPdf } from '../../src/lib/extrasPdf.js'

const font = (name) => new Uint8Array(readFileSync(new URL(`../../og-fonts/${name}`, import.meta.url)))
const fonts = { regular: font('Rajdhani-Medium.ttf'), bold: font('Rajdhani-SemiBold.ttf') }
const event = { name: 'Bieg Łosia — Żółwia Dolina', eventDate: '2026-12-06' }
const generatedAt = new Date('2026-11-25T10:00:00Z')

const item = (i, over = {}) => ({
  bib: i, firstName: 'Łucja', lastName: 'Żółć', name: 'Łucja Żółć', competition: 'Bieg 10 km', team: null,
  extra: 'Koszulka', variant: 'L', qty: 1, paid: 5000, email: 'l@example.pl', phone: '+48 600 000 000', ...over,
})

test('builds a PDF that loads back', async () => {
  const list = { handout: [item(1, { qty: 2 })], awaiting: [item(2)], totals: [{ extraId: 'x', extra: 'Koszulka', variantId: 'v', variant: 'L', count: 2 }] }
  const bytes = await buildExtrasPdf({ list, event, filterText: 'Dodatek: Koszulka', generatedAt, fonts })
  assert.ok(bytes instanceof Uint8Array)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF')
  const doc = await PDFDocument.load(bytes)
  assert.equal(doc.getPageCount(), 1)
})

test('300 items span several pages', async () => {
  const handout = Array.from({ length: 300 }, (_, i) => item(i + 1, {
    lastName: `Bardzo-Długie-Nazwisko-Które-Się-Nie-Mieści-W-Kolumnie-${i}`,
    competition: 'Półmaraton górski z przewyższeniem i nocnym etapem',
  }))
  const list = { handout, awaiting: [], totals: [{ extraId: 'x', extra: 'Koszulka', variantId: 'v', variant: 'L', count: 300 }] }
  const doc = await PDFDocument.load(await buildExtrasPdf({ list, event, filterText: '', generatedAt, fonts }))
  assert.ok(doc.getPageCount() > 1)
})

test('empty list still builds one page', async () => {
  const list = { handout: [], awaiting: [], totals: [] }
  const doc = await PDFDocument.load(await buildExtrasPdf({ list, event: { name: 'X', eventDate: null }, filterText: null, generatedAt, fonts }))
  assert.equal(doc.getPageCount(), 1)
})
