// Post-build script: generates static per-club HTML files for public clubs
// into dist/klub/:slug/index.html.
// Reads .manifest.json produced by backend/scripts/publish-club-pages.js and
// the Vite-built dist/index.html (for hashed asset tags, header/nav styling).
//
// This REPLACES the deployed Supabase `render-club` SSR edge function — the
// Supabase edge runtime forces `text/plain` on HTML responses there, breaking
// crawlers/JSON-LD. These pages are plain static HTML served directly by
// Vercel, same approach as generate-event-pages.js / generate-leszyrun-event-pages.js.
//
// Unlike /events/:slug, the SPA does NOT own the bare /klub/:slug route (only
// /klub/:slug/dolacz — invite-accept — is an SPA route). So all content here
// is rendered directly (not gated behind <noscript>) — there is no client-side
// hydration pass that would otherwise duplicate it.
//
// Runs alongside the other generate-*.js scripts in the `build` chain. Empty
// manifest (no public clubs yet) is a no-op: exits 0 without writing anything.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/klub/.manifest.json')
const BASE_URL = 'https://www.leszy.run'

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildDescription(c) {
  if (c.description) return c.description.slice(0, 200)
  const loc = c.city ? ` (${c.city})` : ''
  return `${c.name} — klub biegowy na leszy.run${loc}.`
}

function buildJsonLd(c) {
  const url = `${BASE_URL}/klub/${c.slug}`
  const sportsTeam = {
    '@type': 'SportsTeam',
    name: c.name,
    url,
    ...(c.logoUrl ? { logo: c.logoUrl } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.city ? { location: { '@type': 'Place', name: c.city } } : {}),
  }
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: c.name, item: url },
    ],
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [sportsTeam, breadcrumb] }, null, 2)
}

// Visible page body — full club profile, always rendered (no SPA hydration
// owns this route, so nothing here can rely on <noscript> as a fallback).
function buildBody(c) {
  const memberListHtml = (c.visibleMembers && c.visibleMembers.length)
    ? `<ul>${c.visibleMembers.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '<p>Brak publicznie widocznych członków.</p>'

  return `    <h1>${escapeHtml(c.name)}</h1>
    ${c.logoUrl ? `<img src="${escapeHtml(c.logoUrl)}" alt="${escapeHtml(c.name)}" width="128" height="128">` : ''}
    ${c.description ? `<p>${escapeHtml(c.description)}</p>` : ''}
    ${c.city ? `<p>${escapeHtml(c.city)}${c.voivodeship ? `, ${escapeHtml(c.voivodeship)}` : ''}</p>` : ''}
    <p>Liczba członków: ${c.memberCount}</p>
    <h2>Członkowie</h2>
    ${memberListHtml}
    <p><a href="/">Dołącz do leszy.run</a></p>`
}

function buildClubHtml(c, cssLinks, jsScripts) {
  const title = `${escapeHtml(c.name)} — klub biegowy | leszy.run`
  const description = escapeHtml(buildDescription(c))
  const canonical = `${BASE_URL}/klub/${c.slug}`
  const jsonLd = buildJsonLd(c).replace(/<\//g, '<\\/')

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
    ${c.logoUrl ? `<meta property="og:image" content="${escapeHtml(c.logoUrl)}" />` : ''}
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />
    <meta name="twitter:card" content="${c.logoUrl ? 'summary_large_image' : 'summary'}" />
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
${buildBody(c)}
    ${jsScripts}
  </body>
</html>`
}

// Former slug → tiny redirect stub. Vercel can't 301 per-club without
// generating vercel.json, so: canonical (SEO) + meta refresh + JS redirect.
function buildRedirectHtml(club) {
  const target = `${BASE_URL}/klub/${club.slug}`
  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(club.name)} — leszy.run</title>
    <link rel="canonical" href="${target}" />
    <meta name="robots" content="noindex" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <script>window.location.replace(${JSON.stringify(target)})</script>
  </head>
  <body>
    <p>Ten klub ma nowy adres: <a href="${target}">${target}</a></p>
  </body>
</html>`
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`Manifest not found at ${MANIFEST_PATH} — skipping club page generation.`)
    return
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  } catch (err) {
    console.error(`Could not parse manifest: ${err.message}`)
    process.exit(1)
  }
  if (!Array.isArray(manifest)) {
    console.error('Manifest must be a JSON array of club objects.')
    process.exit(1)
  }
  console.log(`Found ${manifest.length} public club(s) in manifest.`)
  if (manifest.length === 0) return

  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) {
    console.error(`dist/index.html not found at ${indexPath} — did vite build run?`)
    process.exit(1)
  }
  const indexHtml = readFileSync(indexPath, 'utf-8')
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')
  const jsScripts = (indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')

  const liveSlugs = new Set(manifest.map((c) => c.slug))

  let generated = 0
  for (const club of manifest) {
    if (!club.slug) continue
    const dir = resolve(DIST, 'klub', club.slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'index.html'), buildClubHtml(club, cssLinks, jsScripts))
    generated++

    for (const old of club.formerSlugs || []) {
      if (!old || old === club.slug) continue
      // Defensive: a former slug should never collide with another club's
      // live slug (create-club's uniqueSlug() guard prevents this at mint
      // time), but never let a stub silently overwrite a real page.
      if (liveSlugs.has(old)) {
        console.warn(`skipping former-slug stub ${old} — collides with a live club page`)
        continue
      }
      const oldDir = resolve(DIST, 'klub', old)
      mkdirSync(oldDir, { recursive: true })
      writeFileSync(resolve(oldDir, 'index.html'), buildRedirectHtml(club))
      generated++
    }
  }
  console.log(`Generated ${generated} club HTML file(s).`)
}

main()
