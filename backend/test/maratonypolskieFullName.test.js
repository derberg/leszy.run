import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDetailName, isTruncatedName } from '../src/scrapers/sources/maratonypolskie.js'

// The listing cuts a long name at 40 characters and adds "...", with no title
// attribute or other copy of the full name. "VII Charytatywny ZwariOWany Trip
// Nocny d..." (code 91506) reached the review queue that way, and neither the
// enricher's search nor a person could find the race by it. The detail page
// carries the full name in its orange heading. Markup copied 2026-11-26.

const DETAIL = `<TD VALIGN='top' WIDTH=750 ALIGN='center' COLSPAN=2><BR><FONT FACE='verdana' SIZE=6 COLOR='orange'><B>&nbsp;VII Charytatywny ZwariOWany Trip Nocny dla Mikołaja</FONT></B><BR><FONT SIZE=1><FONT COLOR=grey>Zaloguj się aby zobaczyć wszystkie nazwy wydarzenia<BR>&nbsp;</TD>`

test('the detail page heading gives the full name', () => {
  assert.equal(parseDetailName(DETAIL), 'VII Charytatywny ZwariOWany Trip Nocny dla Mikołaja')
})

test('a page without the heading gives no name', () => {
  assert.equal(parseDetailName('<html><body>Błąd</body></html>'), null)
})

test('only a name the listing cut is looked up', () => {
  assert.equal(isTruncatedName('VII Charytatywny ZwariOWany Trip Nocny d...'), true)
  assert.equal(isTruncatedName('XVIII Bieg Uliczny o Łaziskie Liście'), false)
})
