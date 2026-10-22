import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrape, parseFormFee } from '../src/scrapers/sources/zmierzymyczas.js'

// zmierzymyczas never states the fee on the event page. It lives only on the
// /edit/ registration form, as radio labels and hidden rodz_cena_hid_<id> inputs.
// Row 2683 (Statuetka - cykl biegów KB Harcownik 2026, 2026-12-31) published with
// price_from null because the form was never read. Markup below is trimmed from
// /edit/2683/statuetka-cykl-biegow-kb-harcownik-2026.html, sampled 2026-10-22.

const SLUG = 'statuetka-cykl-biegow-kb-harcownik-2026'
const NAME = 'Statuetka - cykl biegów KB Harcownik 2026'

const listing = `<html><body><table class="table-bordered zebra"><tbody>
  <tr>
    <td id="zapisy_list_data"><a href="/2683/${SLUG}.html">2026-12-31</a></td>
    <td id="zapisy_list_nazwa"><a href="/2683/${SLUG}.html">${NAME}</a></td>
    <td id="zapisy_list_dystans"><a href="/2683/${SLUG}.html">cykl biegów Harcownika</a></td>
    <td id="zapisy_list_miejsce"><a href="/2683/${SLUG}.html">Jelcz-Laskowice</a></td>
  </tr>
</tbody></table></body></html>`

const detail = `<html><body>
  <a href="/images/regulaminy/20261231_Jelcz-Laskowice_-_Statuetka-Harcownik_2026.pdf">Zasady</a>
  <a href="/edit/2683/${SLUG}.html" class="link-form">Formularz rejestracyjny</a>
</body></html>`

const form = `<html><body><form>
<div class="control-group"><div class="controls">
  <label class="radio"><input type="radio" name="rodz" value="2618" />
				JEDNA STATUETKA - 40 PLN			</label>
  <label class="radio"><input type="radio" name="rodz" value="2619" />
				DWIE STATUETKI - 80 PLN			</label>
  <label class="radio"><input type="radio" name="rodz" value="2620" />
				TRZY STATUETKI - 120 PLN			</label>
  <label class="radio"><input type="radio" name="rodz" value="2621" />
				CZTERY STATUETKI - 160 PLN			</label>
</div></div><input type='hidden' name='rodz_cena_hid_2618' id='rodz_cena_hid_2618' value='40' /><input type='hidden' name='rodz_cena_hid_2619' id='rodz_cena_hid_2619' value='80' /><input type='hidden' name='rodz_cena_hid_2620' id='rodz_cena_hid_2620' value='120' /><input type='hidden' name='rodz_cena_hid_2621' id='rodz_cena_hid_2621' value='160' />
</form></body></html>`

function stubFetch(pages) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const body = pages(String(url))
    return { ok: body !== null, text: async () => body ?? '' }
  }
  return () => { globalThis.fetch = original }
}

test('2683 carries the fee from its registration form', async () => {
  const restore = stubFetch((url) => {
    if (url === 'https://www.zmierzymyczas.pl/') return listing
    if (url.includes('/edit/2683/')) return form
    if (url.includes('/2683/')) return detail
    return null
  })
  try {
    const [row] = await scrape()
    assert.equal(row.source_id, '2683')
    assert.equal(row.price_from, 40)
    assert.equal(row.price_to, 160)
  } finally {
    restore()
  }
})

test('an unreadable registration form leaves the fee null and keeps the row', async () => {
  const restore = stubFetch((url) => {
    if (url === 'https://www.zmierzymyczas.pl/') return listing
    if (url.includes('/edit/2683/')) return null
    if (url.includes('/2683/')) return detail
    return null
  })
  try {
    const [row] = await scrape()
    assert.equal(row.registration_url, `https://www.zmierzymyczas.pl/edit/2683/${SLUG}.html`)
    assert.equal(row.price_from, null)
    assert.equal(row.price_to, null)
  } finally {
    restore()
  }
})

test('parseFormFee keeps 0 as a free race', () => {
  const html = `<input type='hidden' name='rodz_cena_hid_1' value='0' /><input type='hidden' name='rodz_cena_hid_2' value='30' />`
  assert.deepEqual(parseFormFee(html), { priceFrom: 0, priceTo: 30 })
})

test('parseFormFee falls back to the PLN labels', () => {
  const html = `<label>5 KM - 50 PLN</label><label>10 KM - 70,50 PLN</label>`
  assert.deepEqual(parseFormFee(html), { priceFrom: 50, priceTo: 70.5 })
})

test('parseFormFee returns null when the form shows no fee', () => {
  assert.equal(parseFormFee('<form><input name="imie" /></form>'), null)
})
