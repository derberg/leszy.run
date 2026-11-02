// GET /api/event-og?slug=<slug>: the 1200x630 link preview image of one
// leszy.run event, drawn with the kalendarz template (scripts/generate-event-og.js)
// and cached by Vercel's CDN. api/event-page.js and the pre-rendered past event
// pages point og:image here. An unknown slug gets the site's own image.
//
// Imports by relative path only (see api/event.js).
import { createClient } from '@supabase/supabase-js'
import { renderEventOg } from '../scripts/generate-event-og.js'
import { isEventSlug, readEventShareFields } from '../src/lib/eventShareMeta.js'

let supabase = null

function client() {
  supabase ??= createClient(
    process.env.VITE_SUPABASE_URL?.trim(),
    process.env.VITE_SUPABASE_ANON_KEY?.trim(),
    {
      auth: { persistSession: false },
      global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) }) },
    },
  )
  return supabase
}

function fallback(res, cacheControl) {
  res.statusCode = 302
  res.setHeader('Location', '/og-image.png')
  for (const [k, v] of Object.entries(cacheControl)) res.setHeader(k, v)
  res.end()
}

// A preview image is fetched once per share, by a crawler that caches it
// itself, so an hour is fresh enough for a renamed event.
const CACHED = {
  'Vercel-CDN-Cache-Control': 'max-age=3600, stale-while-revalidate=86400, stale-if-error=86400',
  'Cache-Control': 'public, max-age=3600',
}
const NO_STORE = { 'Cache-Control': 'no-store' }

export default async function handler(req, res) {
  // One spelling of the query string, so the CDN keeps one entry per event.
  const params = new URL(req.url, 'http://localhost').searchParams
  const slug = params.get('slug')
  if ([...params.keys()].length !== 1 || !isEventSlug(slug)) return fallback(res, CACHED)
  try {
    const fields = await readEventShareFields(client(), slug)
    if (!fields) return fallback(res, CACHED)
    const png = await renderEventOg({
      name: fields.name,
      date: fields.date,
      location: fields.location,
      distances: fields.distances,
    }, { footer: `leszy.run/events/${slug}` })
    res.statusCode = 200
    res.setHeader('Content-Type', 'image/png')
    for (const [k, v] of Object.entries(CACHED)) res.setHeader(k, v)
    res.end(png)
  } catch (err) {
    console.error(`[api/event-og] ${slug}: ${err.message}`)
    fallback(res, NO_STORE)
  }
}
