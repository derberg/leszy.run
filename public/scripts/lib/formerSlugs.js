// A kalendarz page's address carries the race date (`<name>-<yyyy-mm-dd>`), so
// a race that moves (run-publish follows a source's new date), is renamed, or
// gains an id suffix gets a new address. Without this the old one, already
// indexed and linked, fell through to the SPA's not-found state: HTTP 200 with
// noindex, a soft 404.
//
// publish-event-pages.js records every address an event has had in its manifest
// entry (`former_slugs`, matched by event id against the previously published
// manifest, carried forward run after run), and generate-event-pages.js writes
// a redirect stub at each one, as generate-club-pages.js does for a renamed
// club: canonical + meta refresh + JS redirect, because a static Vercel build
// cannot answer a per-page 301 without generating vercel.json.

export const FORMER_SLUGS_MAX = 20

/**
 * Give every entry of `next` the addresses its event had before, read from the
 * previously published manifest `prev` by event id. Mutates `next`.
 * A former address that is some live entry's address is dropped: a live page
 * always wins over a redirect.
 * @returns {{ from: string, to: string }[]} addresses that changed in this run
 */
export function carryFormerSlugs(prev, next, max = FORMER_SLUGS_MAX) {
  const prevById = new Map()
  for (const [slug, entry] of Object.entries(prev || {})) {
    if (entry?.id) prevById.set(entry.id, { slug, former: Array.isArray(entry.former_slugs) ? entry.former_slugs : [] })
  }
  const live = new Set(Object.keys(next))
  const changed = []
  for (const [slug, entry] of Object.entries(next)) {
    const before = entry?.id ? prevById.get(entry.id) : null
    if (!before) continue
    const former = [...before.former]
    if (before.slug !== slug) {
      former.push(before.slug)
      changed.push({ from: before.slug, to: slug })
    }
    const kept = [...new Set(former)].filter(s => s && s !== slug && !live.has(s)).slice(-max)
    if (kept.length) entry.former_slugs = kept
    else delete entry.former_slugs
  }
  return changed
}

/**
 * Redirect stubs to write: one per former address of a live entry, never over a
 * live page and never twice (two events claiming one old address: the first wins).
 * @returns {{ slug: string, target: string, event: object }[]}
 */
export function redirectStubs(manifest) {
  const live = new Set(Object.keys(manifest))
  const seen = new Set()
  const stubs = []
  for (const [target, event] of Object.entries(manifest)) {
    for (const slug of event?.former_slugs || []) {
      if (!slug || live.has(slug) || seen.has(slug)) continue
      seen.add(slug)
      stubs.push({ slug, target, event })
    }
  }
  return stubs
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function buildRedirectHtml(event, target, baseUrl) {
  const url = `${baseUrl}/kalendarz/${target}`
  const name = escapeHtml(event?.name)
  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <title>${name} — leszy.run</title>
    <link rel="canonical" href="${url}" />
    <meta name="robots" content="noindex" />
    <meta http-equiv="refresh" content="0; url=${url}" />
    <script>window.location.replace(${JSON.stringify(url)})</script>
  </head>
  <body>
    <p>${name} ma nowy adres: <a href="${url}">${url}</a></p>
  </body>
</html>
`
}
