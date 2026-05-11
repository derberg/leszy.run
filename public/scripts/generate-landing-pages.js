// Post-build script: generates per-landing-page HTML files and appends to sitemap.xml.
// Reads public/biegi/.manifest.json (written by backend/scripts/publish-landing-pages.js).
// Run after generate-event-pages.js via the build script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/biegi/.manifest.json')
const BASE_URL = 'https://www.leszy.run'

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildJsonLd(entry) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: entry.h1,
    description: entry.description,
    url: entry.canonicalUrl,
    inLanguage: 'pl-PL',
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
        { '@type': 'ListItem', position: 2, name: 'Biegi w Polsce', item: `${BASE_URL}/biegi` },
      ],
    },
  }
  if (entry.path !== 'biegi') {
    ld.breadcrumb.itemListElement.push(
      { '@type': 'ListItem', position: 3, name: entry.h1, item: entry.canonicalUrl }
    )
  }
  return JSON.stringify(ld, null, 2).replace(/<\//g, '<\\/')
}

function buildLandingHtml(entry, cssLinks, jsScripts) {
  const title = escapeHtml(entry.title)
  const description = escapeHtml(entry.description)
  const canonical = entry.canonicalUrl
  const jsonLd = buildJsonLd(entry)
  // Embed full manifest entry as landing-data for React hydration
  const landingData = JSON.stringify(entry).replace(/<\//g, '<\\/')

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
    <meta property="og:image" content="${BASE_URL}/og-image.png" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${BASE_URL}/og-image.png" />

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
    <script id="landing-data" type="application/json">${landingData}</script>
    ${jsScripts}
  </body>
</html>`
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`No landing pages manifest at ${MANIFEST_PATH} — skipping.`)
    return
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  const paths = Object.keys(manifest)
  console.log(`Found ${paths.length} landing page entries in manifest.`)

  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) { console.error(`dist/index.html not found — did vite build run?`); process.exit(1) }

  const indexHtml = readFileSync(indexPath, 'utf-8')
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')
  const jsScripts = (indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')
  console.log(`Extracted CSS/JS from index.html.`)

  let generated = 0
  for (const path of paths) {
    const entry = manifest[path]
    // path is like 'biegi' or 'biegi/przelajowe/slaskie'
    const dir = resolve(DIST, path)
    mkdirSync(dir, { recursive: true })
    const html = buildLandingHtml(entry, cssLinks, jsScripts)
    writeFileSync(resolve(dir, 'index.html'), html)
    generated++
  }
  console.log(`Generated ${generated} landing page HTML files.`)

  // Append to sitemap written by generate-event-pages.js
  const sitemapPath = resolve(DIST, 'sitemap.xml')
  if (!existsSync(sitemapPath)) { console.error('sitemap.xml not found — run generate-event-pages.js first'); process.exit(1) }

  let sitemap = readFileSync(sitemapPath, 'utf-8')
  sitemap = sitemap.replace('</urlset>', '')

  const entries = paths.map(path => {
    const entry = manifest[path]
    return `  <url>\n    <loc>${entry.canonicalUrl}</loc>\n    <changefreq>${entry.sitemapChangefreq}</changefreq>\n    <priority>${entry.sitemapPriority}</priority>\n  </url>`
  })

  sitemap += entries.join('\n') + '\n</urlset>\n'
  writeFileSync(sitemapPath, sitemap)
  console.log(`Appended ${paths.length} landing page URLs to sitemap.xml.`)
}

main()
