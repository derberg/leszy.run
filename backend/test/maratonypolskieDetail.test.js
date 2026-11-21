import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDetailPage } from '../src/scrapers/sources/maratonypolskie.js'

// Detail page for code=91439 (23. Krakowski Półmaraton Marzanny, 2027-03-21),
// saved raw as the site serves it, in iso-8859-2.
const html = new TextDecoder('iso-8859-2').decode(
  readFileSync(new URL('./fixtures/maratonypolskie-91439.html', import.meta.url)),
)

test('the discipline row "Biegi" becomes event_type bieg', () => {
  assert.equal(parseDetailPage(html).event_type, 'bieg')
})

test('the "Zapisy na stronie" link becomes registration_url', () => {
  assert.equal(parseDetailPage(html).registration_url, 'https://www.polmaratonmarzanny.pl/zapisy/')
})

test('the OPŁATY STARTOWE tiers give the lowest and highest fee', () => {
  const d = parseDetailPage(html)
  assert.equal(d.price_from, 179)
  assert.equal(d.price_to, 279)
})

test('a page without a fee block, link or known discipline leaves the fields unset', () => {
  const d = parseDetailPage(`<table><tr><td><img src='pikto/dyscyp9.png'></td><td>Coś innego</td></tr></table>`)
  assert.equal(d.event_type, null)
  assert.equal(d.registration_url, null)
  assert.equal(d.price_from, null)
  assert.equal(d.price_to, null)
})

test('a page listing more than one discipline leaves event_type unset, not bieg', () => {
  const multi = html.replace('&nbsp;&nbsp;Biegi<BR>', '&nbsp;&nbsp;Biegi, Nordic Walking<BR>')
  assert.notEqual(multi, html)
  assert.equal(parseDetailPage(multi).event_type, null)
})
