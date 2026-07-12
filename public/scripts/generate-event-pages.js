// Post-build script: generates per-event HTML files + sitemap into dist/
// Reads .manifest.json produced by publish-event-pages.js and the Vite-built index.html.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/kalendarz/.manifest.json')
const BASE_URL = 'https://www.leszy.run'
const TODAY = new Date().toISOString().slice(0, 10)
// How many related events to show on each /kalendarz/:slug page (static <a> links for crawlers).
const RELATED_EVENTS_MAX = 12

const DB_TO_TYPE_SLUG = {
  'trail': 'przelajowe',
  'uliczny': 'uliczne',
  'ultra': 'ultramaratony',
  'nocny': 'nocne',
  'ocr': 'ocr',
  'nordic walking': 'nordic-walking',
  'charytatywny': 'charytatywne',
}

const TYPE_SLUG_LABEL = {
  'przelajowe': 'Biegi przełajowe',
  'uliczne': 'Biegi uliczne',
  'ultramaratony': 'Ultramaratony',
  'nocne': 'Biegi nocne',
  'ocr': 'Biegi OCR',
  'nordic-walking': 'Nordic Walking',
  'charytatywne': 'Biegi charytatywne',
}

const DB_TO_REGION_SLUG = {
  'Dolnośląskie': 'dolnoslaskie',
  'Kujawsko-Pomorskie': 'kujawsko-pomorskie',
  'Lubelskie': 'lubelskie',
  'Lubuskie': 'lubuskie',
  'Łódzkie': 'lodzkie',
  'Małopolskie': 'malopolskie',
  'Mazowieckie': 'mazowieckie',
  'Opolskie': 'opolskie',
  'Podkarpackie': 'podkarpackie',
  'Podlaskie': 'podlaskie',
  'Pomorskie': 'pomorskie',
  'Śląskie': 'slaskie',
  'Świętokrzyskie': 'swietokrzyskie',
  'Warmińsko-Mazurskie': 'warminsko-mazurskie',
  'Wielkopolskie': 'wielkopolskie',
  'Zachodniopomorskie': 'zachodniopomorskie',
}

const POLISH_MONTHS = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'
]

function formatPolishDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return ''
  return `${d.getDate()} ${POLISH_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildDescription(event) {
  const parts = []
  if (event.date) parts.push(formatPolishDate(event.date))
  if (event.location) parts.push(event.location)
  if (event.distances && Array.isArray(event.distances) && event.distances.length > 0) {
    parts.push(event.distances.join(', '))
  }
  if (event.event_type) {
    const types = Array.isArray(event.event_type) ? event.event_type : [event.event_type]
    parts.push(types.join(', '))
  }
  return parts.join(' \u00B7 ')
}

function buildJsonLd(event, slug) {
  const startDate = event.date ? event.date.slice(0, 10) : undefined
  const eventUrl = `${BASE_URL}/kalendarz/${slug}`
  const datePublished = event.created_at ? String(event.created_at).slice(0, 10) : startDate
  const dateModified = event.updated_at ? String(event.updated_at).slice(0, 10) : datePublished

  const sportsEvent = {
    '@type': 'SportsEvent',
    name: event.name,
    description: buildDescription(event) || undefined,
    startDate,
    endDate: startDate,
    eventStatus: event.status === 'cancelled'
      ? 'https://schema.org/EventCancelled'
      : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    image: `${eventUrl}/og.png`,
    url: eventUrl,
    inLanguage: 'pl-PL',
    datePublished,
    dateModified,
    location: {
      '@type': 'Place',
      name: event.location || undefined,
      address: {
        '@type': 'PostalAddress',
        addressRegion: event.voivodeship || undefined,
        addressCountry: 'PL',
      },
    },
    organizer: {
      '@type': 'Organization',
      name: 'Organizator',
      url: event.website || event.registration_url || eventUrl,
    },
  }

  if (event.lat != null && event.lng != null) {
    sportsEvent.location.geo = {
      '@type': 'GeoCoordinates',
      latitude: event.lat,
      longitude: event.lng,
    }
  }

  if (event.price_from != null) {
    sportsEvent.offers = {
      '@type': 'AggregateOffer',
      lowPrice: event.price_from,
      highPrice: event.price_to != null ? event.price_to : event.price_from,
      priceCurrency: 'PLN',
      availability: 'https://schema.org/InStock',
      validFrom: new Date().toISOString().slice(0, 10),
      url: event.registration_url || eventUrl,
    }
    if (event.registration_deadline) {
      sportsEvent.offers.priceValidUntil = event.registration_deadline.slice(0, 10)
    } else if (startDate) {
      sportsEvent.offers.priceValidUntil = startDate
    }
  }

  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: 'Kalendarz', item: `${BASE_URL}/kalendarz` },
      { '@type': 'ListItem', position: 3, name: event.name, item: eventUrl },
    ],
  }

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [sportsEvent, breadcrumb] }, null, 2)
}

function buildRelatedNav(event) {
  const links = [{ href: '/listy', label: 'Wszystkie biegi w Polsce' }]

  const types = Array.isArray(event.event_type) ? event.event_type : (event.event_type ? [event.event_type] : [])
  for (const t of types) {
    const slug = DB_TO_TYPE_SLUG[t]
    if (slug) links.push({ href: `/listy/${slug}`, label: TYPE_SLUG_LABEL[slug] })
  }

  const regionSlug = event.voivodeship ? DB_TO_REGION_SLUG[event.voivodeship] : null
  if (regionSlug) links.push({ href: `/listy/${regionSlug}`, label: `Biegi — ${event.voivodeship}` })

  const items = links.map(l => `      <a href="${l.href}" style="color:#B0AEC6;font-size:0.8rem;padding:0.25rem 0.625rem;border:1px solid #262638;text-decoration:none;white-space:nowrap">${escapeHtml(l.label)}</a>`).join('\n')
  return `  <nav aria-label="Powiązane kategorie biegów" style="padding:1.25rem 1.5rem;background:#0A0A10;border-top:1px solid #1C1C2A">
    <span style="display:block;font-family:sans-serif;font-size:0.65rem;color:#8886A0;margin-bottom:0.625rem;text-transform:uppercase;letter-spacing:0.08em">Więcej biegów</span>
    <div style="display:flex;flex-wrap:wrap;gap:0.375rem">
${items}
    </div>
  </nav>`
}

// Pick up to RELATED_EVENTS_MAX future events sharing this event's region or type, ranked
// by (sameRegion ? 3 : 0) + (sharesType ? 2 : 0), then by absolute date proximity.
// Renders as static <a href="/kalendarz/:slug"> so Googlebot has a crawlable link from this
// page to siblings \u2014 fixes the "Discovered \u2013 currently not indexed" orphan pattern for events
// that don't yet appear on a small-enough listy page to be reliably crawled.
function buildRelatedEvents(event, currentSlug, manifest, today) {
  const currentTypes = new Set(Array.isArray(event.event_type) ? event.event_type : (event.event_type ? [event.event_type] : []))
  const currentRegion = event.voivodeship || null
  const currentDateStr = event.date ? event.date.slice(0, 10) : today
  const currentTime = new Date(currentDateStr + 'T00:00:00').getTime()

  const candidates = []
  for (const slug of Object.keys(manifest)) {
    if (slug === currentSlug) continue
    const e = manifest[slug]
    const d = e.date ? e.date.slice(0, 10) : null
    if (!d || d < today) continue
    const types = new Set(Array.isArray(e.event_type) ? e.event_type : (e.event_type ? [e.event_type] : []))
    let sharesType = false
    for (const t of types) { if (currentTypes.has(t)) { sharesType = true; break } }
    const sameRegion = currentRegion && e.voivodeship === currentRegion
    if (!sharesType && !sameRegion) continue
    const score = (sameRegion ? 3 : 0) + (sharesType ? 2 : 0)
    const proximity = Math.abs(new Date(d + 'T00:00:00').getTime() - currentTime)
    candidates.push({ slug, e, score, proximity })
  }
  candidates.sort((a, b) => b.score - a.score || a.proximity - b.proximity)
  const top = candidates.slice(0, RELATED_EVENTS_MAX)
  if (top.length === 0) return ''

  const items = top.map(({ slug, e }) => {
    const dateLabel = e.date ? formatPolishDate(e.date.slice(0, 10)) : ''
    const parts = [e.name]
    if (dateLabel) parts.push(dateLabel)
    if (e.location) parts.push(e.location)
    const label = escapeHtml(parts.join(' \u2014 '))
    return `      <li style="margin:0"><a href="/kalendarz/${escapeHtml(slug)}" style="color:#B0AEC6;text-decoration:none;display:block;padding:0.25rem 0">${label}</a></li>`
  }).join('\n')

  return `  <nav aria-label="Powi\u0105zane biegi" style="padding:1.25rem 1.5rem;background:#0A0A10;border-top:1px solid #1C1C2A;font-family:'Rajdhani',sans-serif">
    <h2 style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;color:#DDDCEC;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 0.625rem">Powi\u0105zane biegi</h2>
    <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0 1rem;font-size:0.8rem">
${items}
    </ul>
  </nav>`
}

function buildEventHtml(event, slug, cssLinks, jsScripts, manifest, today) {
  const title = `${escapeHtml(event.name)} \u2014 ${escapeHtml(formatPolishDate(event.date))} \u2014 Leszy.run`
  const description = escapeHtml(buildDescription(event))
  const canonical = `${BASE_URL}/kalendarz/${slug}`
  const ogImage = `${BASE_URL}/kalendarz/${slug}/og.png`
  const isPast = (event.date || '').slice(0, 10) < today
  const robotsContent = isPast ? 'noindex, follow' : 'index, follow'

  // Escape </ in JSON to prevent script tag injection
  const eventJson = JSON.stringify(event).replace(/<\//g, '<\\/')
  const jsonLd = buildJsonLd(event, slug).replace(/<\//g, '<\\/')

  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="${robotsContent}" />
    <link rel="canonical" href="${canonical}" />

    <!-- Open Graph -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${ogImage}" />

    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="/logo-bez-napisu.svg" />
    <link rel="apple-touch-icon" href="/logo-bez-napisu.svg" />

    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">

    <!-- JSON-LD SportsEvent -->
    <script type="application/ld+json">
    ${jsonLd}
    </script>

    <!-- Theme flash prevention -->
    <script>
      (function() {
        var t = localStorage.getItem('leszy-theme');
        if (t === 'dark') document.documentElement.classList.add('dark');
        else if (t === 'light' || !window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('light');
      })();
    </script>

    ${cssLinks}
  </head>
  <body>
    <div id="root"></div>
    ${buildRelatedNav(event)}
${buildRelatedEvents(event, slug, manifest, today)}
    <script id="event-data" type="application/json">${eventJson}</script>
    ${jsScripts}
  </body>
</html>`
}

function buildSitemap(slugs, manifest) {
  const today = new Date().toISOString().slice(0, 10)
  const staticEntries = [
    { loc: `${BASE_URL}/`, priority: '1.0', changefreq: 'weekly' },
    { loc: `${BASE_URL}/kalendarz`, priority: '0.9', changefreq: 'daily' },
  ]

  const entries = staticEntries.map(e =>
    `  <url>\n    <loc>${e.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
  )

  let skipped = 0
  for (const slug of slugs) {
    const ev = manifest[slug]
    const eventDate = (ev && ev.date) ? ev.date.slice(0, 10) : null
    // Skip past events: keeps Google's crawl budget on indexable URLs and matches the
    // past-month noindex pattern in generate-landing-pages.js.
    if (eventDate && eventDate < today) { skipped++; continue }
    const lastmod = eventDate || today
    entries.push(
      `  <url>\n    <loc>${BASE_URL}/kalendarz/${slug}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
    )
  }

  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`, included: entries.length, skipped }
}

// --- Main ---

function main() {
  // 1. Read manifest
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`Manifest not found at ${MANIFEST_PATH} — skipping event page generation.`)
    return
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  } catch (err) {
    console.error(`Could not parse manifest: ${err.message}`)
    process.exit(1)
  }

  const slugs = Object.keys(manifest)
  console.log(`Found ${slugs.length} events in manifest.`)

  // 2. Read dist/index.html to extract Vite's hashed assets
  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) {
    console.error(`dist/index.html not found at ${indexPath} — did vite build run?`)
    process.exit(1)
  }

  const indexHtml = readFileSync(indexPath, 'utf-8')

  // Extract CSS link tags
  const cssMatches = indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []
  const cssLinks = cssMatches.join('\n    ')

  // Extract JS module script tags (attribute order may vary in Vite output)
  const jsMatches = indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []
  const jsScripts = jsMatches.join('\n    ')

  console.log(`Extracted ${cssMatches.length} CSS links, ${jsMatches.length} JS scripts from index.html.`)

  // 3. Generate per-event HTML files
  let generated = 0
  let pastCount = 0
  for (const slug of slugs) {
    const event = manifest[slug]
    const dir = resolve(DIST, 'kalendarz', slug)
    mkdirSync(dir, { recursive: true })

    const html = buildEventHtml(event, slug, cssLinks, jsScripts, manifest, TODAY)
    writeFileSync(resolve(dir, 'index.html'), html)
    generated++
    if ((event.date || '').slice(0, 10) < TODAY) pastCount++
  }

  console.log(`Generated ${generated} event HTML files (${pastCount} past-event noindex).`)

  // 4. Generate sitemap (past events excluded)
  const { xml, included, skipped } = buildSitemap(slugs, manifest)
  writeFileSync(resolve(DIST, 'sitemap.xml'), xml)
  console.log(`Generated sitemap.xml with ${included} entries (${skipped} past events excluded).`)
}

main()
