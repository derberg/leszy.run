import * as cheerio from 'cheerio'

// motivato.pl — editorial Polish running portal (Astro static site, NOT WordPress).
//
// The ENTIRE calendar is one server-rendered page: every event is an
// <article data-race-item> whose data-* attributes already carry the date, region,
// distance taxonomy and surface. Detail pages (/biegi/<slug>/) were checked and add
// NOTHING (no prices, no regulamin, no deadline), so this scraper makes exactly ONE
// HTTP request for the whole source and does zero detail fetches.
//
// Because every field comes off the listing, this uses the "emit all events, no detail
// fetches" pattern (adding-a-new-scraper §5): re-emitting a known row is idempotent and
// cannot null anything, so `knownIds` is accepted but deliberately not used to filter.
//
// WHY IT'S WORTH SCRAPING: motivato is editorial, not a registration platform, so it
// lists events that register on their OWN websites — the structural blind spot every
// timing-platform scraper shares. Measured 2026-08-27: of 123 dated events, ~21 were
// absent from calendar_events, skewed hard to mountain/ultra/trail and marquee city
// road races (Bieg Niepodległości Warszawa, Toruń Maraton, UltraKotlina, Smok Ultra…).
//
// WHAT IT'S BAD AT: the "Sprawdź zapisy" outbound link is editorially curated and
// frequently is NOT a registration page. Verified across all 70 distinct hosts
// (2026-08-27) the field contains, in roughly equal measure: real deep-links into
// registration platforms, bare organizer homepages, regulamin PDFs, a regulamin HTML
// page, a Facebook page, and one malformed `https://http://…` URL. So the link is
// ROUTED by destination (see classifyOutbound) instead of being trusted as
// registration_url. Anything unrecognised becomes `website` and the enricher resolves
// a real registration URL later — a null registration_url is far cheaper than a wrong one.

const BASE_URL = 'https://motivato.pl'
const LIST_URL = `${BASE_URL}/kalendarz-biegowy/`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// Hosts that are dedicated registration / timing platforms — a link here is a real
// sign-up entry point. Every entry was verified on 2026-08-27 by following the full
// redirect chain from motivato's own href and confirming the destination carries
// event-specific content (not a generic login or landing page). Most are platforms we
// already scrape, so their URL shapes are known-good.
const REGISTRATION_HOSTS = [
  'dostartu.pl',                  // dostartu.pl/s-otwinska-dycha-v16762 — also gets free apiEnrich
  'zapisy.mktime.pl',             // dostartu-like (see apiEnrich.js)
  'zapisy.o-timing.pl',           // dostartu-like (see apiEnrich.js)
  'b4sportonline.pl',             // /bieg_na_babia/
  'elektronicznezapisy.pl',       // /event/15274.html
  'datasport.pl',                 // liveds.datasport.pl/zawody_files/zawody11477.html
  'bgtimesport.pl',               // /zawody/biegi/id/825
  'superczas.pl',                 // /biegobroncowplocka/zapisy
  'timekeeper.pl',                // competitions.timekeeper.pl/<slug>
  'sts-timing.pl',                // zapisy.sts-timing.pl/1135/
  'personalbest.pl',              // zapisy.personalbest.pl/<slug>-v16750
  'domtel-sport.pl',              // zapisy.domtel-sport.pl/<slug>-v15533
  'chronotex.pl',                 // /opis-zawodow/?id_zawodow=1354
  'pomiarczasuatelier.pl',        // /zapisy/<slug>
  'foxter-sport.pl',              // → v1.foxter-sport.pl/<slug>
  'time-sport.pl',                // /2026/zapisy/zapisy-<slug>.html
  'ultimasport.pl',               // formularz.ultimasport.pl/485
  'protimer.pl',                  // /bio/1382/<slug>/page
  'time4s.pl',                    // /szczesliwa-13ka-2026
  'zmierzymyczas.pl',             // /2576/<slug>.html
  'maratonczykpomiarczasu.pl',    // panel.maratonczykpomiarczasu.pl/<slug>
  'sportmaniacs.com',             // /pl/services/inscription/<slug>-87386
  'go.decathlon.pl',              // /l/ix-bieg-motyli/<uuid>
  'my.raceresult.com',            // /405447/registration
  'e-gepard.eu',                  // platform we scrape (show-contest/<id>)
  'zapisyonline.pl',              // platform we scrape
  'triso.pl',                     // zapisyonline's backing platform
  'docs.google.com',              // a Google Form IS the registration for small events
]

// Organizer-hosted registration entry points. Verified pattern: when an organizer runs
// its own sign-up it lives on a dedicated subdomain or a `rejestracja-` host —
// zapisy.pomerania-sports.pl, rejestracja.maratonwarszawski.com, events.silesiamarathon.pl,
// formularz.ultimasport.pl, panel.maratonczykpomiarczasu.pl. Every instance found on
// 2026-08-27 was a genuine registration page, so the subdomain is treated as the signal.
const REGISTRATION_SUBDOMAINS = /^(zapisy|rejestracja|formularz|panel|events|rejestracja-[a-z0-9-]+)\./i

// Tracking junk motivato passes through from wherever it harvested the link.
const TRACKING_PARAMS = /^(fbclid|gclid|hl|utm_[a-z_]+|_ga|mc_[a-z]+)$/i

// motivato ships at least one malformed href (`https://http://h2opolmaraton.pro-run.pl/`).
// Recover the inner URL rather than losing the event's only link; return null if the
// result still isn't parseable.
function normalizeUrl(raw) {
  if (!raw) return null
  let s = raw.trim().replace(/&amp;/g, '&')
  // "https://http://X" / "https://http//X" → "http://X". The colon is optional because
  // both shapes turn up in hand-maintained hrefs; requiring it silently dropped the
  // colon-less form (hostname parses as bare "http", then fails the dot check below).
  s = s.replace(/^https?:\/\/(https?):?(\/\/?)/i, (_, scheme) => `${scheme}://`)

  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  if (!u.hostname.includes('.')) return null

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key)
  }
  u.hash = ''
  return u.toString()
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

// Route motivato's single "Sprawdź zapisy" link to the field it actually belongs in.
// Returns one of: { registration_url } | { regulamin_url } | { website } | {}
function classifyOutbound(rawUrl) {
  const url = normalizeUrl(rawUrl)
  if (!url) return {}

  const host = hostOf(url)
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return ''
    }
  })()

  // A regulamin is a regulamin no matter which button pointed at it. Catches
  // pifsport.com.pl/.../Regulamin-biegow-M.-BUBULI-2026.pdf and
  // polmaratongdansk.pl/regulamin-bieg-na-5-km/ — both filed under "zapisy" upstream.
  if (path.endsWith('.pdf') || /(^|\/)regulamin/.test(path)) {
    return { regulamin_url: url }
  }

  if (REGISTRATION_HOSTS.some(d => hostMatches(host, d))) {
    return { registration_url: url }
  }
  if (REGISTRATION_SUBDOMAINS.test(new URL(url).hostname)) {
    return { registration_url: url }
  }
  // Organizer homepage, event page, or social — real, but not a sign-up form.
  // A Facebook page lands here rather than being dropped: for many small Polish events
  // it is their only web presence (feedback_facebook_as_website). The social filter in
  // adding-a-new-scraper §5f guards a "first external link" heuristic; this is a routed
  // declared link, and `website` is the honest field for it.
  return { website: url }
}

// Distance badges → clean "N km" list. motivato is inconsistent about the unit and
// writes all of these: "15,3km", "42,2km", "10 km", "5KM", "400m", and the Polish word
// forms "5 kilometrów" / "43 kilometrowy" / "3,5 kilometrowy". The word forms are why the
// `kilometr…` branch exists — without it Rydułtowy and Maraton Trzech Jezior lose their
// distances entirely.
//
// When motivato has no distance data at all it falls back to putting the EVENT NAME in the
// badge slot ("II Złotowska Dziesiątka", "Poznańska Piwna Mila #20"). Requiring a unit
// right after the number means those yield nothing and we correctly return null, rather
// than mining "20" out of a name.
//
// Deduped because motivato sometimes repeats a distance across its badge list
// (e.g. ['5 km', '10 km', '5KM']).
function cleanDistances(badges) {
  const out = new Set()
  for (const badge of badges) {
    const text = (badge || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(kilometr[a-ząćęłńóśźż]*|km|m)(?![a-ząćęłńóśźż])/gi)) {
      const num = parseFloat(m[1].replace(',', '.'))
      if (!Number.isFinite(num) || num <= 0) continue
      const unit = m[2].toLowerCase().startsWith('kilometr') ? 'km' : m[2].toLowerCase()
      // Sub-kilometre values stay in metres; everything else in km.
      out.add(unit === 'm' && num >= 50 ? `${num} m` : `${num} km`)
    }
  }
  return out.size ? [...out].join(', ') : null
}

// event_types — see adding-a-new-scraper §5b. Detected from the umbrella name (+ the
// distances string) FIRST, exactly like the umbrella-only aggregators we merge against.
// motivato's own data-surface / data-distance taxonomy is used ONLY as a fallback when
// the name yields nothing: deriving a style tag the umbrella name doesn't carry risks a
// {trail} vs {trail, nordic walking} count mismatch in hasDistinguishingConflict, which
// rejects the merge and ships a duplicate.
function detectEventTypes(blob) {
  const s = (blob || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(s)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(s)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(s)) tags.add('ultra')
  if (/\bocr\b/i.test(s)) tags.add('ocr')
  return [...tags]
}

// Fallback style tags from motivato's taxonomy attributes.
// data-surface ∈ {road, mountain, trail}; data-distance ∈ {5km,10km,polmaraton,maraton,gorskie,ultra,dzieci}
//
// Deliberately returns AT MOST ONE tag ('trail'), never a set. hasDistinguishingConflict
// rejects a match when both sides have style tags of differing COUNT, so emitting
// {trail, ultra} here against another source's {ultra} would reject a correct merge and
// ship a duplicate (Maraton Wigry hits exactly this: data-distance="maraton ultra gorskie").
// 'trail' is the safe single choice — it comes from the clean 3-value data-surface field,
// and any same-event row from another source almost always derives it from the name too
// ("górski"/"trail"/"cross"), so both sides land on {style:trail} and the merge holds.
// 'ultra' is dropped: if the event name says "ultra", detectEventTypes already caught it
// and this fallback never runs.
function typesFromTaxonomy(surface, distanceCat) {
  const cat = (distanceCat || '').toLowerCase()
  if (surface === 'mountain' || surface === 'trail' || /\bgorskie\b/.test(cat)) return ['trail']
  return []
}

// Kids signal — \b doesn't handle Polish letters, use manual non-letter boundary.
// Fed the umbrella name AND data-search (which motivato builds from name + city +
// sub-race labels, so it exposes kids races the title hides: "bieg charytatywny pko
// warszawa 5 km biegi dziecięce"). Safe to widen: is_kids does not feed the strict
// `kids:` conflict category in distinguishingTags() — that one reads event.name only.
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  const NB = '[^a-ząćęłńóśźż]'
  // "Bieg Pokoju Pamięci Dzieci Zamojszczyzny" is a memorial race for children who died,
  // not a children's race. The bare `dzieci` test below would flag it, so exclude the
  // memorial phrasing first. (The same false positive exists in the copy-pasted
  // hasKidsSignal in the other scrapers — worth a separate sweep.)
  if (/pami[eę]ci\s+dzieci/.test(s)) return false
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}dzieci[eę]c`).test(s)) return true   // "biegi dziecięce"
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// motivato's city names are hand-typed editorial copy, so a few are misspelled at the
// source. A wrong city is not a cosmetic problem here: dedup's `citiesMatch` compares the
// pre-hyphen city token, so "Żegiestó Zdrój" never matches "Żegiestów-Zdrój" and the same
// race publishes TWICE — once per source — with the typo'd copy also missing a
// voivodeship (run-geocode can't geocode a city that doesn't exist). Keys are lowercased
// and whitespace-collapsed; add an entry only after confirming the correct name (the
// 2026-10-04 X-RUN Wielki Finał is in Żegiestów-Zdrój, gmina Muszyna, małopolskie —
// motivato files it as "Żegiestó Zdrój, świętokrzyskie", both halves wrong).
const CITY_FIXES = {
  'żegiestó zdrój': 'Żegiestów-Zdrój',
}

// "Brenna, śląskie" → "Brenna". The voivodeship half is deliberately NOT emitted:
// motivato's region data has errors (it files Łomnica-Zdrój, a małopolskie village, under
// dolnośląskie), and run-geocode.js derives voivodeship from the city far more reliably.
// Same call herkules.js makes.
function parseCity(text) {
  if (!text) return null
  const city = text.split(',')[0].replace(/\s+/g, ' ').trim()
  if (!city) return null
  return CITY_FIXES[city.toLowerCase()] || city
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
    html = await res.text()
  } catch (err) {
    console.error('[motivato] Listing fetch failed:', err.message)
    return []
  }

  const $ = cheerio.load(html)
  const articles = $('article[data-race-item]')

  const parsed = []
  let undated = 0

  articles.each((_, el) => {
    const article = $(el)

    const sourceId = (article.attr('data-id') || '').trim()
    if (!sourceId) return

    // Events with an approximate date ("wrzesień 2026 — termin przybliżony") ship a bare
    // `data-date` attribute with no value. No parseable date → drop the row.
    const date = (article.attr('data-date') || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      undated++
      return
    }

    const titleLink = article.find('h3[data-race-title] a').first()
    const name = titleLink.text().replace(/\s+/g, ' ').trim()
    if (!name) return

    const detailHref = titleLink.attr('href') || ''
    const sourceUrl = detailHref ? new URL(detailHref, BASE_URL).toString() : null

    const location = parseCity(article.find('h3[data-race-title]').next('p').first().text())

    // Scoped to the card body so the footer's surface label ("asfalt"/"góry") can't leak
    // in, and keyed on the badge background rather than the full Tailwind class string.
    const badges = article
      .find('[data-card-body] span[class*="bg-zinc-100"]')
      .map((__, span) => $(span).text())
      .get()
    const distances = cleanDistances(badges)

    const surface = (article.attr('data-surface') || '').trim().toLowerCase()
    const distanceCat = (article.attr('data-distance') || '').trim().toLowerCase()

    let eventTypes = detectEventTypes(`${name} ${distances || ''}`)
    if (eventTypes.length === 0) eventTypes = typesFromTaxonomy(surface, distanceCat)

    const searchBlob = (article.attr('data-search') || '').trim()
    const isKids =
      hasKidsSignal(name) || hasKidsSignal(searchBlob) || /\bdzieci\b/.test(distanceCat)

    const outboundRaw = article
      .find('[data-upcoming-action] a[href^="http"], [data-upcoming-action] a[href^="//"]')
      .first()
      .attr('href')

    parsed.push({
      name,
      date,
      location,
      distances,
      eventTypes,
      isKids,
      sourceId,
      sourceUrl,
      outbound: normalizeUrl(outboundRaw),
    })
  })

  // motivato reuses one outbound link across unrelated events (osir.zamosc.pl/news/319-…
  // is attached to both "37. Bieg Pokoju" and "Półmaraton Roztoczański";
  // janosikraceseries.com/janosikultrarace/zapisy/ to both "Janosik Ultra Race" and
  // "IX Biegi Górskie Sanok"). At most one of them can be right and we can't tell which,
  // so drop the link from ALL of them and let the enricher resolve each event properly.
  const outboundCounts = new Map()
  for (const e of parsed) {
    if (e.outbound) outboundCounts.set(e.outbound, (outboundCounts.get(e.outbound) || 0) + 1)
  }

  const results = []
  let sharedLinks = 0
  const routed = { registration_url: 0, regulamin_url: 0, website: 0, none: 0 }

  for (const e of parsed) {
    let link = e.outbound
    if (link && outboundCounts.get(link) > 1) {
      sharedLinks++
      link = null
    }

    const classified = link ? classifyOutbound(link) : {}
    const field = Object.keys(classified)[0]
    routed[field || 'none']++

    results.push({
      name: e.name,
      date: e.date,
      location: e.location,
      distances: e.distances,
      registration_url: classified.registration_url || null,
      registration_deadline: null,   // not exposed by motivato → enricher
      regulamin_url: classified.regulamin_url || null,
      website: classified.website || null,
      is_kids: e.isKids,
      event_types: e.eventTypes.length ? e.eventTypes : null,
      price_from: null,              // not exposed by motivato → enricher
      price_to: null,
      lat: null,                     // motivato's inline lat/lng are plain city centroids
      lng: null,                     // run-geocode reproduces them from `location`
      source: 'motivato',
      source_id: e.sourceId,
      source_url: e.sourceUrl,
    })
  }

  console.log(
    `[motivato] Listing: ${articles.length} articles, ${results.length} usable ` +
    `(${undated} dropped — approximate date), ${knownIds.size} already known (re-emitted)`
  )
  console.log(
    `[motivato] Outbound links routed: registration=${routed.registration_url} ` +
    `regulamin=${routed.regulamin_url} website=${routed.website} none=${routed.none} ` +
    `(${sharedLinks} dropped — same link on multiple events)`
  )

  return results
}

export {
  scrape,
  classifyOutbound,
  normalizeUrl,
  cleanDistances,
  detectEventTypes,
  typesFromTaxonomy,
  hasKidsSignal,
  parseCity,
}
