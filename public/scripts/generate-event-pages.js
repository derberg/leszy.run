// Post-build script: generates per-event HTML files + sitemap into dist/
// Reads .manifest.json produced by publish-event-pages.js and the Vite-built index.html.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/kalendarz/.manifest.json')
const BASE_URL = 'https://leszy.run'

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
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: event.name,
    startDate: event.date ? event.date.slice(0, 10) : undefined,
    url: `${BASE_URL}/kalendarz/${slug}`,
    location: {
      '@type': 'Place',
      name: event.location || undefined,
      address: {
        '@type': 'PostalAddress',
        addressRegion: event.voivodeship || undefined,
        addressCountry: 'PL',
      },
    },
  }

  if (event.end_date) {
    ld.endDate = event.end_date.slice(0, 10)
  }

  if (event.lat != null && event.lng != null) {
    ld.location.geo = {
      '@type': 'GeoCoordinates',
      latitude: event.lat,
      longitude: event.lng,
    }
  }

  if (event.price_from != null) {
    ld.offers = {
      '@type': 'AggregateOffer',
      lowPrice: event.price_from,
      priceCurrency: 'PLN',
      availability: 'https://schema.org/InStock',
    }
    if (event.price_to != null) {
      ld.offers.highPrice = event.price_to
    }
    if (event.registration_url) {
      ld.offers.url = event.registration_url
    }
  }

  return JSON.stringify(ld, null, 2)
}

function buildEventHtml(event, slug, cssLinks, jsScripts) {
  const title = `${escapeHtml(event.name)} \u2014 ${escapeHtml(formatPolishDate(event.date))} \u2014 Leszy.run`
  const description = escapeHtml(buildDescription(event))
  const canonical = `${BASE_URL}/kalendarz/${slug}`
  const ogImage = `${BASE_URL}/kalendarz/${slug}/og.png`

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
    <meta name="robots" content="index, follow" />
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
    <script id="event-data" type="application/json">${eventJson}</script>
    ${jsScripts}
  </body>
</html>`
}

function buildSitemap(slugs) {
  const staticEntries = [
    { loc: `${BASE_URL}/`, priority: '1.0', changefreq: 'weekly' },
    { loc: `${BASE_URL}/kalendarz`, priority: '0.9', changefreq: 'daily' },
    { loc: `${BASE_URL}/kalendarz/dodaj`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${BASE_URL}/events`, priority: '0.7', changefreq: 'weekly' },
  ]

  const entries = staticEntries.map(e =>
    `  <url>\n    <loc>${e.loc}</loc>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
  )

  for (const slug of slugs) {
    entries.push(
      `  <url>\n    <loc>${BASE_URL}/kalendarz/${slug}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
    )
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
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
  for (const slug of slugs) {
    const event = manifest[slug]
    const dir = resolve(DIST, 'kalendarz', slug)
    mkdirSync(dir, { recursive: true })

    const html = buildEventHtml(event, slug, cssLinks, jsScripts)
    writeFileSync(resolve(dir, 'index.html'), html)
    generated++
  }

  console.log(`Generated ${generated} event HTML files.`)

  // 4. Generate sitemap
  const sitemap = buildSitemap(slugs)
  writeFileSync(resolve(DIST, 'sitemap.xml'), sitemap)
  console.log(`Generated sitemap.xml with ${4 + slugs.length} entries.`)
}

main()
