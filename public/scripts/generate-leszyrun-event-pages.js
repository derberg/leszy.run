// Post-build script: generates static per-past-event HTML files for leszy.run events
// into dist/events/:slug/ and appends them to dist/sitemap.xml.
// Reads .manifest.json produced by backend/scripts/publish-leszyrun-events.js
// and the Vite-built dist/index.html (for hashed asset tags).
// Runs AFTER generate-event-pages.js (which creates sitemap.xml) and BEFORE/with
// generate-landing-pages.js (both append to the same sitemap).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
// Shared position logic — never copy locally (see CLAUDE.md); plain JS, safe to import in node.
import { estimatePositions } from '../../packages/ui/src/lib/positionEstimation.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/events/.manifest.json')
const BASE_URL = 'https://www.leszy.run'
const TODAY = new Date().toISOString().slice(0, 10)

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
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildDescription(e) {
  const parts = []
  if (e.date) parts.push(formatPolishDate(e.date))
  if (e.location) parts.push(e.location)
  const st = e.stats || {}
  if (st.participants) parts.push(`${st.participants} zawodników`)
  if (Array.isArray(st.distances) && st.distances.length) parts.push(st.distances.join(', '))
  return parts.join(' · ')
}

function buildJsonLd(e) {
  const url = `${BASE_URL}/events/${e.slug}`
  const startDate = e.date ? e.date.slice(0, 10) : undefined
  const sportsEvent = {
    '@type': 'SportsEvent',
    name: e.name,
    description: buildDescription(e) || undefined,
    startDate,
    endDate: startDate,
    eventStatus: 'https://schema.org/EventCompleted',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url,
    inLanguage: 'pl-PL',
    location: e.location ? {
      '@type': 'Place',
      name: e.location,
      address: { '@type': 'PostalAddress', addressCountry: 'PL' },
    } : undefined,
    organizer: { '@type': 'Organization', name: 'Leszy.run', url: BASE_URL },
  }
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: 'Wydarzenia', item: `${BASE_URL}/events` },
      { '@type': 'ListItem', position: 3, name: e.name, item: url },
    ],
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [sportsEvent, breadcrumb] }, null, 2)
}

// Static, crawlable summary + results link + cross-links to other past events.
// Lives OUTSIDE #root so it survives in the DOM for crawlers (React owns only #root).
function buildStaticBody(e, manifest) {
  const st = e.stats || {}
  const statLine = [
    st.participants ? `${st.participants} zapisanych` : null,
    (Array.isArray(st.distances) && st.distances.length) ? st.distances.join(', ') : null,
  ].filter(Boolean).map(escapeHtml).join(' · ')

  const others = Object.keys(manifest).filter(s => s !== e.slug)
  const links = others.map(s => {
    const o = manifest[s]
    const label = escapeHtml([o.name, formatPolishDate(o.date)].filter(Boolean).join(' — '))
    return `      <li style="margin:0"><a href="/events/${escapeHtml(s)}" style="color:#B0AEC6;text-decoration:none;display:block;padding:0.25rem 0">${label}</a></li>`
  }).join('\n')

  const crossNav = others.length ? `  <nav aria-label="Inne minione wydarzenia" style="padding:1.25rem 1.5rem;background:#0A0A10;border-top:1px solid #1C1C2A;font-family:'Rajdhani',sans-serif">
    <h2 style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;color:#DDDCEC;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 0.625rem">Inne minione wydarzenia</h2>
    <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0 1rem;font-size:0.8rem">
${links}
    </ul>
  </nav>` : ''

  return `  <noscript>
    <h1>${escapeHtml(e.name)}</h1>
    <p>${escapeHtml(formatPolishDate(e.date))}${e.location ? ` · ${escapeHtml(e.location)}` : ''}</p>
    <p>${statLine}</p>
    <p><a href="/events/${escapeHtml(e.slug)}/results">Zobacz wyniki</a></p>
  </noscript>
${crossNav}`
}

// Same format the SPA uses in CategorySection.jsx
function formatDuration(ms) {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

const STATUS_LABELS = { dnf: 'DNF', dns: 'DNS', dsq: 'DSQ' }

function buildResultsJsonLd(e) {
  const url = `${BASE_URL}/events/${e.slug}/results`
  const startDate = e.date ? e.date.slice(0, 10) : undefined
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SportsEvent',
        name: `Wyniki — ${e.name}`,
        startDate,
        endDate: startDate,
        eventStatus: 'https://schema.org/EventCompleted',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        url,
        inLanguage: 'pl-PL',
        location: e.location ? {
          '@type': 'Place',
          name: e.location,
          address: { '@type': 'PostalAddress', addressCountry: 'PL' },
        } : undefined,
        organizer: { '@type': 'Organization', name: 'Leszy.run', url: BASE_URL },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
          { '@type': 'ListItem', position: 2, name: e.name, item: `${BASE_URL}/events/${e.slug}` },
          { '@type': 'ListItem', position: 3, name: 'Wyniki', item: url },
        ],
      },
    ],
  }, null, 2)
}

// Static, crawlable results tables. Visible in raw HTML; a MutationObserver hides the
// block once React mounts into #root, so JS visitors get the SPA exactly as before.
function buildStaticResultsBody(e) {
  const sections = (e.results || []).map(cat => {
    // Final ordering via the shared estimator — races here are finished, so tier 1
    // (finish time) decides and empty checkpoints/observations are irrelevant.
    const enriched = estimatePositions(cat.rows.map(r => ({
      id: r.participantId,
      participantId: r.participantId,
      startTime: r.startTime,
      finishTime: r.finishTime,
      durationMs: r.durationMs,
      gunDurationMs: r.gunDurationMs,
      status: r.status,
      participant: { bibNumber: r.bib, firstName: r.firstName, lastName: r.lastName, club: r.club },
      _deleted: r.deleted,
    })), [], [])

    const trs = enriched.map((r, i) => {
      const name = r._deleted
        ? 'Uczestnik anonimowy'
        : escapeHtml(`${r.participant.firstName || ''} ${r.participant.lastName || ''}`.trim() || 'Uczestnik')
      const finished = r.durationMs != null && (!r.status || r.status === 'finished')
      const pos = finished ? String(i + 1) : '—'
      const time = finished ? formatDuration(r.durationMs) : (STATUS_LABELS[r.status] || '—')
      return `          <tr>
            <td style="padding:0.3rem 0.75rem;color:#8886A0;font-family:'IBM Plex Mono',monospace">${pos}</td>
            <td style="padding:0.3rem 0.75rem;color:#DDDCEC">${name}</td>
            <td style="padding:0.3rem 0.75rem;color:#8886A0">${escapeHtml(r.participant.club || '')}</td>
            <td style="padding:0.3rem 0.75rem;color:#BBDD00;font-family:'IBM Plex Mono',monospace">${time}</td>
          </tr>`
    }).join('\n')

    return `    <section style="margin:0 0 2rem">
      <h2 style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;color:#DDDCEC;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 0.5rem">${escapeHtml(cat.category)}</h2>
      <div style="overflow-x:auto">
        <table style="border-collapse:collapse;font-size:0.85rem;min-width:480px">
          <thead>
            <tr style="border-bottom:1px solid #262638;text-align:left">
              <th style="padding:0.3rem 0.75rem;color:#8886A0;font-weight:600">#</th>
              <th style="padding:0.3rem 0.75rem;color:#8886A0;font-weight:600">Zawodnik</th>
              <th style="padding:0.3rem 0.75rem;color:#8886A0;font-weight:600">Klub</th>
              <th style="padding:0.3rem 0.75rem;color:#8886A0;font-weight:600">Czas</th>
            </tr>
          </thead>
          <tbody>
${trs}
          </tbody>
        </table>
      </div>
    </section>`
  }).join('\n')

  return `  <div id="static-results" style="padding:1.5rem;background:#0A0A10;font-family:'Rajdhani',sans-serif">
    <h1 style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.6rem;color:#DDDCEC;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 0.25rem">Wyniki — ${escapeHtml(e.name)}</h1>
    <p style="color:#8886A0;margin:0 0 1.5rem">${escapeHtml(formatPolishDate(e.date))}${e.location ? ` · ${escapeHtml(e.location)}` : ''} · <a href="/events/${escapeHtml(e.slug)}" style="color:#B0AEC6">strona wydarzenia</a></p>
${sections}
  </div>
  <script>
    (function() {
      var root = document.getElementById('root')
      new MutationObserver(function(_, obs) {
        if (root.childElementCount > 0) {
          var s = document.getElementById('static-results')
          if (s) s.style.display = 'none'
          obs.disconnect()
        }
      }).observe(root, { childList: true })
    })();
  </script>`
}

function buildResultsHtml(e, cssLinks, jsScripts) {
  const title = `Wyniki — ${escapeHtml(e.name)} — ${escapeHtml(formatPolishDate(e.date))} — Leszy.run`
  const catNames = (e.results || []).map(c => c.category).join(', ')
  const description = escapeHtml(`Oficjalne wyniki — ${e.name}${e.location ? `, ${e.location}` : ''}, ${formatPolishDate(e.date)}. Pozycje i czasy: ${catNames}.`)
  const canonical = `${BASE_URL}/events/${e.slug}/results`
  const eventJson = JSON.stringify(e).replace(/<\//g, '<\\/')
  const jsonLd = buildResultsJsonLd(e).replace(/<\//g, '<\\/')

  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />

    <meta property="og:type" content="website" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />

    <link rel="icon" type="image/svg+xml" href="/logo-bez-napisu.svg" />
    <link rel="apple-touch-icon" href="/logo-bez-napisu.svg" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">

    <script type="application/ld+json">
    ${jsonLd}
    </script>

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
${buildStaticResultsBody(e)}
    <script id="event-data" type="application/json">${eventJson}</script>
    ${jsScripts}
  </body>
</html>`
}

function buildEventHtml(e, cssLinks, jsScripts, manifest) {
  const title = `${escapeHtml(e.name)} — ${escapeHtml(formatPolishDate(e.date))} — Leszy.run`
  const description = escapeHtml(buildDescription(e))
  const canonical = `${BASE_URL}/events/${e.slug}`
  const eventJson = JSON.stringify(e).replace(/<\//g, '<\\/')
  const jsonLd = buildJsonLd(e).replace(/<\//g, '<\\/')

  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />

    <meta property="og:type" content="website" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />

    <link rel="icon" type="image/svg+xml" href="/logo-bez-napisu.svg" />
    <link rel="apple-touch-icon" href="/logo-bez-napisu.svg" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">

    <script type="application/ld+json">
    ${jsonLd}
    </script>

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
${buildStaticBody(e, manifest)}
    <script id="event-data" type="application/json">${eventJson}</script>
    ${jsScripts}
  </body>
</html>`
}

function appendToSitemap(slugs, manifest) {
  const sitemapPath = resolve(DIST, 'sitemap.xml')
  if (!existsSync(sitemapPath)) {
    console.error('sitemap.xml not found — run generate-event-pages.js first')
    process.exit(1)
  }
  let sitemap = readFileSync(sitemapPath, 'utf-8')
  sitemap = sitemap.replace('</urlset>', '')
  const entries = slugs.flatMap(slug => {
    const lastmod = (manifest[slug].date || TODAY).slice(0, 10)
    const urls = [`  <url>\n    <loc>${BASE_URL}/events/${slug}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.5</priority>\n  </url>`]
    if ((manifest[slug].results || []).length > 0) {
      urls.push(`  <url>\n    <loc>${BASE_URL}/events/${slug}/results</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.6</priority>\n  </url>`)
    }
    return urls
  })
  sitemap += entries.join('\n') + (entries.length ? '\n' : '') + '</urlset>\n'
  writeFileSync(sitemapPath, sitemap)
  return entries.length
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`Manifest not found at ${MANIFEST_PATH} — skipping leszy.run event page generation.`)
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
  console.log(`Found ${slugs.length} past leszy.run event(s) in manifest.`)
  if (slugs.length === 0) return

  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) {
    console.error(`dist/index.html not found at ${indexPath} — did vite build run?`)
    process.exit(1)
  }
  const indexHtml = readFileSync(indexPath, 'utf-8')
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')
  const jsScripts = (indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')

  let generated = 0
  let resultsGenerated = 0
  for (const slug of slugs) {
    const dir = resolve(DIST, 'events', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'index.html'), buildEventHtml(manifest[slug], cssLinks, jsScripts, manifest))
    generated++
    if ((manifest[slug].results || []).length > 0) {
      const resultsDir = resolve(dir, 'results')
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(resolve(resultsDir, 'index.html'), buildResultsHtml(manifest[slug], cssLinks, jsScripts))
      resultsGenerated++
    }
  }
  console.log(`Generated ${generated} past-event HTML file(s) + ${resultsGenerated} static results page(s).`)

  const added = appendToSitemap(slugs, manifest)
  console.log(`Appended ${added} past-event URL(s) to sitemap.xml.`)
}

main()
