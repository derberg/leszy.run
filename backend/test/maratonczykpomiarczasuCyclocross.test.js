import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { parseRows } from '../src/scrapers/sources/maratonczykpomiarczasu.js'

// maratonczykpomiarczasu files the PROTOUR CYCLOCROSS CUP 2026/27 rounds as
// running events. The merge drops them (SKIP_KEYWORDS' \w*cyclo\w*, #222), but
// the scraper's own filter let them into scraper_maratonczykpomiarczasu. Name
// copied from the listing; cyclo matches inside a glued word too, as in the merge.

const row = (slug, name) => `<tr>
  <td class="views-field views-field-title"><a href="/content/${slug}">${name}</a></td>
  <td class="views-field views-field-field-event-date"><span content="2026-11-29T10:00:00+01:00">x</span></td>
  <td class="views-field views-field-field-event-city">Kalisz</td>
  <td class="views-field views-field-field-event-province">Wielkopolskie</td>
  <td class="views-field views-field-field-dystans-biegu"></td>
</tr>`

test('cyclocross rounds are not running events', () => {
  const $ = cheerio.load(`<table>
    ${row('protour-1', 'PROTOUR CYCLOCROSS CUP SEZON 2026/27 - Zwierzyn')}
    ${row('protour-2', 'PROTOURCYCLOCROSS CUP Runda 2')}
    ${row('bieg', 'Bieg Niepodległości')}
  </table>`)
  assert.deepEqual(parseRows($).map(r => r.source_id), ['bieg'])
})
