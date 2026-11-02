// GET /api/event-og?slug=<slug>: the 1200x630 link preview image of one
// leszy.run event, drawn by renderLeszyrunEventOg() (scripts/generate-event-og.js)
// and cached by Vercel's CDN. api/event-page.js and the pre-rendered past event
// pages point og:image here. An unknown slug gets the site's own image.
//
// Imports by relative path only (see api/event.js).
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { isEventSlug, readEventShareFields, shortBlurb } from '../src/lib/eventShareMeta.js'

// The function runtime has no system fonts: librsvg drew every letter as an
// empty box. og-fonts/ (copied in by `includeFiles` in vercel.json) holds the
// TTFs the template names, and fontconfig is pointed at them before sharp
// first draws text, which is why the template is imported only after this.
function useBundledFonts() {
  const dir = join(tmpdir(), 'leszy-fontconfig')
  mkdirSync(dir, { recursive: true })
  const conf = join(dir, 'fonts.conf')
  const fonts = fileURLToPath(new URL('../og-fonts/', import.meta.url))
  writeFileSync(conf, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>${fonts}</dir><cachedir>${join(dir, 'cache')}</cachedir></fontconfig>
`)
  process.env.FONTCONFIG_FILE = conf
}

let render = null

async function renderer() {
  if (!render) {
    useBundledFonts()
    ;({ renderLeszyrunEventOg: render } = await import('../scripts/generate-event-og.js'))
  }
  return render
}

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
    const png = await (await renderer())({
      name: fields.name,
      date: fields.date,
      location: fields.location,
      charity: fields.charity,
      blurb: shortBlurb(fields.description, 160),
      tags: fields.tags,
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
