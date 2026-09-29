import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRegulaminFromPageHtml } from '../scripts/lib/registration-page-regulamin.js'

// ZPGS 2027 (2027-01-16, b4sport:13127) published with price_from, price_to and
// registration_deadline all null while carrying a regulamin_url that returns
// HTTP 200. The URL is real; it is just not the document. The organizer's
// /zpgs/regulamin-zpgs/ page is a wrapper: one heading, one link, and the
// rules themselves in a PDF beside it, which states the 230/255/280 zł tiers
// and the 14.01.2027 payment deadline the row is missing.
//
// looksLikeRegulamin() already names this shape ("a scan, or a link-hub") and
// already refuses to call it a regulamin. Nothing acted on the refusal: the
// step fed the wrapper's own two lines to the extracting model, which had
// nothing to read and returned nothing.
//
// Markup reduced from https://www.maratongorstolowych.pl/zpgs/regulamin-zpgs/
// on 2026-09-29, keeping what decides the question: the nav lists both of the
// organizer's races and links each one's rules PAGE, so the only DOCUMENT on
// the wrapper is the one it wraps.
const ZPGS_WRAPPER = `<html><body>
<header><nav><ul>
  <li><a href="/zpgs/">ZPGS</a><ul>
    <li><a href="/zpgs/regulamin-zpgs/">Regulamin ZPGS</a></li>
  </ul></li>
  <li><a href="/sgs/">SGS</a><ul>
    <li><a href="/sgs/regulamin-sgs/">Regulamin SGS</a></li>
  </ul></li>
</ul></nav></header>
<section><div id="content"><article><div class="item-content">
  <h1><strong><a href="https://www.maratongorstolowych.pl/wp-content/uploads/2026/09/ZPGS27_regulamin.docx.pdf">REGULAMIN ZPGS 2027</a></strong></h1>
  <p>&nbsp;</p>
</div></article></div></section>
<footer><a href="/polityka-prywatnosci/">Polityka prywatności</a></footer>
</body></html>`

const ZPGS_ROW = {
  name: 'ZPGS 2027',
  date: '2027-01-16',
  location: 'Kudowa zdrój',
  regulamin_url: 'https://www.maratongorstolowych.pl/zpgs/regulamin-zpgs/',
}

const PDF_BYTES = Buffer.from('%PDF-1.4\nregulamin ZPGS 2027\n')

function stubFetch(routes) {
  return async (url) => {
    const hit = routes[url]
    if (!hit) return { ok: false, status: 404, headers: new Headers(), text: async () => '' }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': hit.contentType }),
      text: async () => hit.body.toString('utf-8'),
      arrayBuffer: async () => hit.body,
    }
  }
}

test('a wrapper page resolves to the document it wraps', async () => {
  const fetchImpl = stubFetch({
    'https://www.maratongorstolowych.pl/wp-content/uploads/2026/09/ZPGS27_regulamin.docx.pdf':
      { contentType: 'application/pdf', body: PDF_BYTES },
  })

  const resolved = await resolveRegulaminFromPageHtml(
    ZPGS_WRAPPER,
    ZPGS_ROW.regulamin_url,
    ZPGS_ROW,
    { fetchImpl },
  )

  assert.equal(
    resolved,
    'https://www.maratongorstolowych.pl/wp-content/uploads/2026/09/ZPGS27_regulamin.docx.pdf',
  )
})

// The other thing a wrapper page links is the PLATFORM's own paperwork. The
// JuraRun Night 2026 row (motivato) points at an elektronicznezapisy download
// URL that answers with HTML, and the only documents on that HTML are the
// portal's terms of service and its privacy policy, footer furniture on every
// page of the site. Both carry the word "regulamin", so the link picker alone
// would take the terms of service and hand a model a document about the
// registration platform in place of a race's rules.
const PORTAL_FOOTER = `<html><body>
<h1>JuraRun Night 2026 — zapisy</h1>
<div><p>Formularz zgłoszeniowy.</p></div>
<footer>
  <a href="regulamin/regulamin_portalu_internetowego_elektronicznezapisy_pl_28_02_2026.pdf">Regulamin portalu</a>
  <a href="regulamin/polityka-prywatnosci.pdf">Polityka prywatności</a>
</footer>
</body></html>`

test('the platform’s own terms are not this race’s regulamin', async () => {
  const resolved = await resolveRegulaminFromPageHtml(
    PORTAL_FOOTER,
    'https://elektronicznezapisy.pl/event/14899/download/85L0m452Z0s0l1f717A146h7u0I9J643/open',
    { name: 'JuraRun Night 2026', date: '2026-10-24', location: 'Podlesice' },
    { fetchImpl: async () => { throw new Error('must not fetch a rejected candidate') } },
  )

  assert.equal(resolved, null)
})
