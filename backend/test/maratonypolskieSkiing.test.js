import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSearchResults } from '../src/scrapers/sources/maratonypolskie.js'

// maratonypolskie lists cross-country ski races in its running search. Each
// listing row starts with a discipline icon, and pikto/ik_19.gif is the one the
// detail page labels "Biegi narciarskie". XI Memoriał Stanisława Michonia
// (code 91455, the 15 km CT/FT of Bieg Piastów) reached the review queue that
// way: its name carries no ski word, so no name filter can catch it.
// Row markup copied from the listing (2026-11-22).

const row = (icon, date, city, code, name) => `<TR><TD BGCOLOR='#5C87E4'><CENTER><img src='pikto/${icon}' border='0' align='middle' alt=''></TD><TD BGCOLOR='#CCCCCC'><FONT SIZE=1 FACE='verdana' COLOR='black'><CENTER>${date} (nd)</TD><TD BGCOLOR='#DDDDDD' ALIGN='left'><FONT SIZE=1 FACE='verdana' COLOR='black'>${city}</TD><TD BGCOLOR='#DDDDDD' ALIGN='left'><FONT SIZE=1 FACE='verdana' COLOR='black'><a class='czte' href='mp_index.php?dzial=3&action=5&code=${code}&bieganie'>${name}</a></TD></TD></TR>`

const page = rows => `<table><tr><td>wyszukane zawody</td></tr><tr><td>DATA</td><td>MIEJSCE</td><td>NAZWA</td></tr>${rows.join('')}</table>`

test('a ski race (discipline icon ik_19) is not a running event', () => {
  const html = page([
    row('ik_19.gif', '14.02.2027', 'Szklarska Poręba', '91455', 'XI Memoriału Stanisława Michonia'),
    row('ik_01.gif', '24.01.2027', 'Chwałowice', '91457', 'Chwałowicki Maraton Napoleoński'),
    row('ik_61.gif', '28.02.2027', 'Gorlice', '91999', 'Gorlicki Bieg Górski'),
  ])
  assert.deepEqual(parseSearchResults(html, '2026-11-22').map(e => e.source_id), ['91457', '91999'])
})
