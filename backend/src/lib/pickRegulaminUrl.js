// Shared "which of these links is the regulamin?" picker.
//
// WHY THIS EXISTS
// Polish timing sites publish several documents per event on the same page:
// the regulamin, plus an oświadczenie (health/consent form), a parental consent
// form, a GDPR clause, a course map, a poster. Scrapers that grabbed "a PDF
// from the page" therefore wrote the wrong document as `regulamin_url` — and
// because the enricher extracts prices/deadline/distances FROM the regulamin,
// one wrong link silently empties (or worse, fabricates) those fields.
//
// Measured 2026-09-11: 25 rows in `scraper_all` carried a consent form as their
// regulamin, 19 of them from zmierzymyczas alone, whose picker kept the LAST
// matching PDF on the page. On zmierzymyczas the regulamin is linked first and
// the oświadczenie second, so the consent form won every single time. 8 of
// those rows then got a fabricated `price_from=0 / price_to=500` range from the
// LLM, which was asked for a fee in a document that has none.
//
// THE RULE: a link is the regulamin only if it SAYS SO. Requiring a positive
// token beats any amount of ordering heuristics, because the ordering differs
// per site while the naming does not — Polish organizers name these files
// descriptively ("regulamin_CPR_2026.pdf", "oswiadczenie_rodzica.pdf").

// Documents that live next to a regulamin and are NOT one. Matched against the
// document's own name and the anchor text ONLY — never the full URL, because
// legitimate regulamin URLs sit under paths like
// `/zapisy/portal/regulaminy/regulamin_12496.pdf` (datasport) that would trip
// a naive whole-URL match on "zapisy".
export const NOT_REGULAMIN =
  /(o[sś]wiadcz|zgod[aęy]|klauzul|\brodo\b|ochrona[-_\s]?danych|polityk|prywatno|map[aky]|tras[ay]|profil|plakat|poster|wynik|lista[-_\s]?startow|ranking|klasyfikacj|pakiet|upowa[zż]nien|za[lł][aą]cznik|harmonogram)/i

// Positive evidence that a link IS the regulamin.
export const IS_REGULAMIN = /(regulamin|regulation|statut|\brules?\b)/i

function basename(href) {
  try {
    // Relative hrefs are fine here — we only want the trailing segment.
    const path = href.split(/[?#]/)[0]
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '')
  } catch {
    return href
  }
}

/**
 * Score one candidate link. Higher is better.
 * @returns {number|null} null = disqualified (it is a known non-regulamin doc)
 */
export function scoreRegulaminCandidate({ href = '', text = '' } = {}) {
  if (!href) return null
  const name = basename(href)
  const label = String(text).replace(/\s+/g, ' ').trim()
  const pdfBonus = /\.pdf($|[?#])/i.test(href) ? 0.5 : 0

  // A positive token in the document's OWN NAME settles it, deny-list included:
  // organizers do publish combined documents ("Regulamin_Rynek_Mocy_RODO.pdf"),
  // and event names legitimately contain deny words
  // ("...Obrony Na-RODO-wej - REGULAMIN.pdf"). Both are real regulamins; a
  // deny-list applied on top of a positive match would throw them away.
  if (IS_REGULAMIN.test(name)) return 3 + pdfBonus

  // No positive evidence in the name — now a known non-regulamin document name
  // or link label disqualifies it. Conservative on purpose: a null regulamin
  // costs one empty field, a consent form written as the regulamin costs every
  // field the enricher extracts from it.
  if (NOT_REGULAMIN.test(name) || NOT_REGULAMIN.test(label)) return null

  if (IS_REGULAMIN.test(label)) return 2 + pdfBonus
  if (IS_REGULAMIN.test(href)) return 1 + pdfBonus
  return 0 + pdfBonus
}

/**
 * Pick the best regulamin link out of a candidate list.
 *
 * @param {Array<{href: string, text?: string}>} candidates  in DOM order
 * @param {object}  [opts]
 * @param {string}  [opts.baseUrl]        resolve relative hrefs against this
 * @param {boolean} [opts.requireToken=true]
 *        true  — a link must carry a "regulamin"/"statut" token to qualify.
 *        false — the caller already knows the links come from a regulamin-only
 *                section (a labelled block, an API field), so an untokenised
 *                link is acceptable; the NOT_REGULAMIN deny-list still applies.
 *                Use this for opaque download URLs such as
 *                elektronicznezapisy.pl/download/<hash>/open, which carry no
 *                token anywhere in the href.
 * @returns {string|null} absolute URL, or null when nothing qualifies
 */
export function pickRegulaminUrl(candidates = [], { baseUrl, requireToken = true } = {}) {
  let best = null
  let bestScore = -1

  for (const c of candidates) {
    const score = scoreRegulaminCandidate(c)
    if (score === null) continue
    if (requireToken && score < 1) continue
    // Strictly greater — ties keep the FIRST candidate, i.e. DOM order.
    if (score > bestScore) {
      bestScore = score
      best = c.href
    }
  }

  if (!best) return null
  if (/^https?:\/\//i.test(best)) return best
  if (!baseUrl) return best
  try {
    return new URL(best, baseUrl).toString()
  } catch {
    return null
  }
}

/**
 * Cheerio convenience wrapper: collect anchors, then pick.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {object}  [opts]
 * @param {string}  [opts.selector='a[href]']
 * @param {*}       [opts.root]   limit the search to this element
 * @param {string}  [opts.baseUrl]
 * @param {boolean} [opts.requireToken=true]
 */
export function pickRegulaminFromDom($, { selector = 'a[href]', root, baseUrl, requireToken } = {}) {
  const scope = root ? $(root).find(selector) : $(selector)
  const candidates = []
  scope.each((_, el) => {
    const href = $(el).attr('href')
    if (href) candidates.push({ href, text: $(el).text() })
  })
  return pickRegulaminUrl(candidates, { baseUrl, requireToken })
}
