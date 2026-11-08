import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raceresultConfigUrl } from '../scripts/lib/regulaminDocument.js'

test('a raceresult content tab is read from its config', () => {
  // Koliba Łomnicka 2027: the regulamin is InfoText in /429910/regulamin/config.
  assert.equal(raceresultConfigUrl('https://my.raceresult.com/429910/regulamin'), 'https://my.raceresult.com/429910/regulamin/config')
  assert.equal(raceresultConfigUrl('https://my.raceresult.com/412049/extcontent/'), 'https://my.raceresult.com/412049/extcontent/config')
  assert.equal(raceresultConfigUrl('https://my.raceresult.com/429910/rejestracja'), null)
  assert.equal(raceresultConfigUrl('https://my.raceresult.com/429910/registration'), null)
  assert.equal(raceresultConfigUrl('https://my.raceresult.com/429910/'), null)
  assert.equal(raceresultConfigUrl('https://example.com/429910/regulamin'), null)
})

import { htmlToText, decodeHtml } from '../scripts/lib/regulaminDocument.js'

test('htmlToText keeps the page text a line per block, without scripts', () => {
  const t = htmlToText('<html><head><style>p{}</style></head><body><nav>Menu</nav><h1>REGULAMIN</h1><h2>CEL IMPREZY</h2><p>Popularyzacja <b>biegania</b>.</p><script>var x=1</script><table><tr><td>5 km</td><td>50 zł</td></tr></table></body></html>')
  assert.equal(t, 'Menu\nREGULAMIN\nCEL IMPREZY\nPopularyzacja biegania.\n5 km 50 zł')
})

test('decodeHtml reads the charset the page declares', () => {
  const latin2 = Buffer.from([0x3c, ...Buffer.from('meta charset="iso-8859-2"><p>Bieg '), 0xb3, 0xb1, 0x6b, 0x61])
  assert.match(decodeHtml(latin2), /Bieg łąka/)
})
