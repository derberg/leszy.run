// Post-build script: generates per-landing-page HTML files, OG images, and appends to sitemap.xml.
// Reads public/listy/.manifest.json (written by backend/scripts/publish-landing-pages.js).
// Run after generate-event-pages.js via the build script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { generateAllLandingOgs } from './generate-landing-og.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/listy/.manifest.json')
const KALENDARZ_MANIFEST_PATH = resolve(ROOT, 'public/kalendarz/.manifest.json')
const BASE_URL = 'https://www.leszy.run'

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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

// Ported verbatim from backend/scripts/publish-landing-pages.js so the static event lists
// rendered here match the eventCount the manifest already reports.
function parseDistanceToMeters(s) {
  if (!s) return NaN
  s = String(s).toLowerCase()
  if (/\d\s*h(\b|$)/.test(s)) return NaN
  if (s.includes('półmaraton') || s.includes('polmaraton')) return 21097
  if (s.includes('maraton')) return 42195
  const match = s.match(/[0-9]+([.,][0-9]+)?/)
  if (!match) return NaN
  const num = parseFloat(match[0].replace(',', '.'))
  if (isNaN(num)) return NaN
  if (/km|kilometr/.test(s)) return Math.round(num * 1000)
  if (/\d\s*m\b|metr/.test(s)) return Math.round(num)
  return Math.round(num * 1000)
}

function getEventTypes(e) {
  return Array.isArray(e.event_type) ? e.event_type : e.event_type ? [e.event_type] : []
}

function matchesFacet(event, filters) {
  const { typeDbVal, regionDb, year, month, special, city } = filters || {}
  if (special === 'polmaratony') {
    if (!(event.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 19000 && m <= 23000 })) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'maratony') {
    if (!(event.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 41000 && m <= 44000 })) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'dla-dzieci') {
    if (!(Array.isArray(event.event_type) ? event.event_type : []).includes('dzieci')) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'darmowe') {
    if (event.price_from !== 0) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'ostatnia-szansa') {
    if (!event.registration_deadline) return false
    const daysUntil = (new Date(event.registration_deadline) - new Date()) / 86400000
    if (!(daysUntil >= 0 && daysUntil <= 14)) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (typeDbVal && !getEventTypes(event).includes(typeDbVal)) return false
  if (regionDb && event.voivodeship !== regionDb) return false
  if (city) {
    const eventCity = event.location ? event.location.split(/[\n,]/)[0].replace(/\s+/g, ' ').trim() : null
    if (!eventCity || eventCity.toLowerCase() !== city.toLowerCase()) return false
  }
  if (year && month) {
    const d = new Date(event.date + 'T00:00:00')
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return false
  }
  return true
}

// Render the static event index that lives inside every /listy/* page. Each item is a
// crawlable <a href="/kalendarz/:slug"> — this is the fix for "Discovered – currently not
// indexed" on the 1,604 event pages: they need static inbound links from pages Google
// already crawls (the listy pages are indexed and crawled regularly).
function buildEventListHtml(events) {
  if (!events || events.length === 0) return ''
  const items = events.map(({ slug, e }) => {
    const dateLabel = e.date ? formatPolishDate(e.date.slice(0, 10)) : ''
    const parts = [e.name]
    if (dateLabel) parts.push(dateLabel)
    if (e.location) parts.push(e.location)
    const label = escapeHtml(parts.join(' — '))
    return `      <li style="margin:0"><a href="/kalendarz/${escapeHtml(slug)}" style="color:#B0AEC6;text-decoration:none;display:block;padding:0.25rem 0">${label}</a></li>`
  }).join('\n')
  return `  <nav id="seo-event-index" aria-label="Pełna lista biegów" style="padding:1.5rem;background:#0A0A10;border-top:1px solid #1C1C2A;font-family:'Rajdhani',sans-serif">
    <h2 style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.95rem;color:#DDDCEC;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 0.75rem">Pełna lista biegów (${events.length})</h2>
    <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 1.25rem;font-size:0.8rem">
${items}
    </ul>
  </nav>`
}

const POLISH_MONTH_SLUGS = {
  styczen: 1, luty: 2, marzec: 3, kwiecien: 4, maj: 5, czerwiec: 6,
  lipiec: 7, sierpien: 8, wrzesien: 9, pazdziernik: 10, listopad: 11, grudzien: 12,
}

function isPastMonthPage(path) {
  const m = path.match(/^listy\/(\d{4})\/([a-z]+)$/)
  if (!m) return false
  const year = parseInt(m[1], 10)
  const monthNum = POLISH_MONTH_SLUGS[m[2]]
  if (!monthNum) return false
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  return year < currentYear || (year === currentYear && monthNum < currentMonth)
}

function buildJsonLd(entry) {
  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
    { '@type': 'ListItem', position: 2, name: 'Lista kategorii', item: `${BASE_URL}/listy` },
  ]
  if (entry.path !== 'listy') {
    breadcrumbItems.push({ '@type': 'ListItem', position: 3, name: entry.h1, item: entry.canonicalUrl })
  }

  const graph = [
    {
      '@type': 'CollectionPage',
      name: entry.h1,
      description: entry.description,
      url: entry.canonicalUrl,
      inLanguage: 'pl-PL',
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems,
    },
  ]

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2).replace(/<\//g, '<\\/')
}

function buildLandingHtml(entry, cssLinks, jsScripts, ogImageUrl, pastMonth = false, events = []) {
  const title = escapeHtml(entry.title)
  const description = escapeHtml(entry.description)
  const canonical = entry.canonicalUrl
  const jsonLd = buildJsonLd(entry)
  // Embed full manifest entry as landing-data for React hydration
  const landingData = JSON.stringify(entry).replace(/<\//g, '<\\/')
  const ogImage = ogImageUrl || `${BASE_URL}/og-image.png`
  // Thin landing pages (<4 events) are near-duplicates of the kalendarz with no content of
  // their own — Google clusters them as "duplicate, different canonical" and they drag down
  // sitewide quality (July 2026 update filtered the whole domain). Same for ALL monthly pages
  // (/listy/.../2026/lipiec): hundreds of near-identical date-sliced variants of the evergreen
  // pages. noindex both (keep follow so related-category links still pass equity); evergreen
  // pages with real inventory stay indexable. Kept out of the sitemap below.
  const isMonthly = Boolean(entry.filters && entry.filters.month)
  const isThin = (entry.eventCount || 0) < 4
  const robotsContent = (pastMonth || isMonthly || isThin) ? 'noindex, follow' : 'index, follow'
  const eventListHtml = pastMonth ? '' : buildEventListHtml(events)

  const relatedLinksHtml = (entry.relatedLinks && entry.relatedLinks.length > 0)
    ? entry.relatedLinks.map(l =>
        `      <a href="/${escapeHtml(l.path)}" style="color:#B0AEC6;font-size:0.8rem;padding:0.25rem 0.625rem;border:1px solid #262638;text-decoration:none;white-space:nowrap">${escapeHtml(l.h1)}${l.eventCount ? ` (${l.eventCount})` : ''}</a>`
      ).join('\n')
    : ''

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

    <!-- JSON-LD CollectionPage (id matches useSeo hook — updated by React on hydration) -->
    <script id="seo-page-jsonld" type="application/ld+json">
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
${eventListHtml}
    ${relatedLinksHtml ? `  <nav id="seo-related" aria-label="Powiązane listy biegów" style="padding:1.25rem 1.5rem;background:#0A0A10;border-top:1px solid #1C1C2A">
    <span style="display:block;font-family:sans-serif;font-size:0.65rem;color:#8886A0;margin-bottom:0.625rem;text-transform:uppercase;letter-spacing:0.08em">Powiązane kategorie</span>
    <div style="display:flex;flex-wrap:wrap;gap:0.375rem">
${relatedLinksHtml}
    </div>
  </nav>` : ''}
    <script id="landing-data" type="application/json">${landingData}</script>
    ${jsScripts}
  </body>
</html>`
}

async function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`No landing pages manifest at ${MANIFEST_PATH} — skipping.`)
    return
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  const paths = Object.keys(manifest)
  console.log(`Found ${paths.length} landing page entries in manifest.`)

  // Load kalendarz manifest so we can pre-render static event links into each /listy/* page.
  // Without these links the 1,604 /kalendarz/:slug pages are sitemap-only orphans and
  // Google leaves them "Discovered – currently not indexed."
  let futureEvents = []
  if (existsSync(KALENDARZ_MANIFEST_PATH)) {
    const kalendarz = JSON.parse(readFileSync(KALENDARZ_MANIFEST_PATH, 'utf-8'))
    const today = new Date().toISOString().slice(0, 10)
    futureEvents = Object.keys(kalendarz)
      .map(slug => ({ slug, e: kalendarz[slug] }))
      .filter(({ e }) => (e.date || '').slice(0, 10) >= today)
      .sort((a, b) => (a.e.date || '').localeCompare(b.e.date || ''))
    console.log(`Loaded ${futureEvents.length} future events from kalendarz manifest (of ${Object.keys(kalendarz).length} total).`)
  } else {
    console.log(`kalendarz manifest not found at ${KALENDARZ_MANIFEST_PATH} — static event lists will be empty.`)
  }

  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) { console.error(`dist/index.html not found — did vite build run?`); process.exit(1) }

  const indexHtml = readFileSync(indexPath, 'utf-8')
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')
  const jsScripts = (indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')
  console.log(`Extracted CSS/JS from index.html.`)

  // Generate per-page OG images into dist/
  await generateAllLandingOgs(DIST)

  let generated = 0
  let noindexCount = 0
  let totalEventLinks = 0
  for (const path of paths) {
    const entry = manifest[path]
    const pastMonth = isPastMonthPage(path)
    // path is like 'listy' or 'listy/przelajowe/slaskie'
    const dir = resolve(DIST, path)
    mkdirSync(dir, { recursive: true })
    // Per-page OG image written alongside index.html
    const ogImageUrl = `${BASE_URL}/${path}/og.png`
    const events = (pastMonth || futureEvents.length === 0) ? [] : futureEvents.filter(({ e }) => matchesFacet(e, entry.filters))
    const html = buildLandingHtml(entry, cssLinks, jsScripts, ogImageUrl, pastMonth, events)
    writeFileSync(resolve(dir, 'index.html'), html)
    generated++
    if (pastMonth || (entry.filters && entry.filters.month) || (entry.eventCount || 0) < 4) noindexCount++
    totalEventLinks += events.length
  }
  console.log(`Generated ${generated} landing page HTML files (${noindexCount} noindex: monthly / thin / past-month; ${totalEventLinks} static event links emitted).`)

  // Append to sitemap written by generate-event-pages.js
  const sitemapPath = resolve(DIST, 'sitemap.xml')
  if (!existsSync(sitemapPath)) { console.error('sitemap.xml not found — run generate-event-pages.js first'); process.exit(1) }

  let sitemap = readFileSync(sitemapPath, 'utf-8')
  sitemap = sitemap.replace('</urlset>', '')

  const today = new Date().toISOString().slice(0, 10)
  // Only list indexable pages: exclude everything noindexed above (monthly, thin <4 events, past-month).
  const indexablePaths = paths.filter(path =>
    !isPastMonthPage(path)
    && !(manifest[path].filters && manifest[path].filters.month)
    && (manifest[path].eventCount || 0) >= 4
  )
  const entries = indexablePaths.map(path => {
    const entry = manifest[path]
    return `  <url>\n    <loc>${entry.canonicalUrl}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${entry.sitemapChangefreq}</changefreq>\n    <priority>${entry.sitemapPriority}</priority>\n  </url>`
  })

  sitemap += entries.join('\n') + '\n</urlset>\n'
  writeFileSync(sitemapPath, sitemap)
  console.log(`Appended ${indexablePaths.length} landing page URLs to sitemap.xml (${paths.length - indexablePaths.length} monthly / thin / past-month pages excluded).`)
}

main().catch(err => { console.error(err); process.exit(1) })
