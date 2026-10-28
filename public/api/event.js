// GET /api/event?slug=<slug>: a registration event's public page data as one
// JSON document, built by registration_public() in Supabase and cached by
// Vercel's CDN. Same model as api/results.js: the CDN answers the viewers,
// Supabase sees about one request per event per minute per CDN region, and no
// public page queries Supabase per viewer.
//
// Imports by relative path only: Vite's @registration alias does not exist
// inside a Vercel Function.
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { withFileUrls } from '../src/lib/eventFiles.js'

// Same rule as isValidSlug() in _shared/registration/slug.js and the
// registration_settings_slug_check constraint.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

let supabase = null

function client() {
  supabase ??= createClient(
    process.env.VITE_SUPABASE_URL?.trim(),
    process.env.VITE_SUPABASE_ANON_KEY?.trim(),
    {
      auth: { persistSession: false },
      // A stalled Supabase fails the build in 8 s; the CDN keeps serving its
      // last good copy meanwhile (see api/results.js).
      global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) }) },
    },
  )
  return supabase
}

function send(res, status, body, headers) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

// An error is never cached.
const NO_STORE = { 'Cache-Control': 'no-store' }

// A hit and a 404 alike: refreshed every 60 s, a stale copy served for up to
// 10 minutes while a refresh runs or fails. Caching the 404 keeps a link to a
// draft or a mistyped slug from reaching Supabase on every view.
const CACHED = {
  // Vercel's CDN reads this header and strips it before the response leaves.
  'Vercel-CDN-Cache-Control': 'max-age=60, stale-while-revalidate=600, stale-if-error=600',
  'Cache-Control': 'public, max-age=0, must-revalidate',
}

export default async function handler(req, res) {
  // One spelling of the query string, so the CDN keeps one entry per event.
  const params = new URL(req.url, 'http://localhost').searchParams
  const slug = params.get('slug')
  if ([...params.keys()].length !== 1 || !slug || slug.length < 3 || slug.length > 80 || !SLUG.test(slug)) {
    return send(res, 400, { error: 'expected ?slug=<event slug> and nothing else' }, NO_STORE)
  }
  try {
    const { data, error } = await client().rpc('registration_public', { p_slug: slug })
    if (error) throw new Error(error.message)
    if (!data) return send(res, 404, { error: 'not found' }, CACHED)
    const raw = withFileUrls(data, process.env.VITE_SUPABASE_URL.trim())
    // Changes only when the data does, so a page can skip a re-render.
    const version = createHash('sha1').update(JSON.stringify(raw)).digest('hex')
    send(res, 200, { version, generatedAt: new Date().toISOString(), ...raw }, { ...CACHED, ETag: `"${version}"` })
  } catch (err) {
    console.error(`[api/event] ${slug}: ${err.message}`)
    send(res, 502, { error: 'event unavailable' }, NO_STORE)
  }
}
