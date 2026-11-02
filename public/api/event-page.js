// GET /events/<slug> (rewritten here by vercel.json when no static page
// exists): the SPA shell with the event's own title, description and Open
// Graph tags. A link preview (Facebook, Messenger, Slack) runs no JavaScript,
// so without this every upcoming event shared as the homepage. The page itself
// is unchanged: the same index.html and bundle, and useSeo() still sets the
// tags in the browser. A past event keeps its pre-rendered page, which Vercel
// serves before any rewrite.
//
// Imports by relative path only (see api/event.js).
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { injectShareMeta, isEventSlug, readEventShareFields } from '../src/lib/eventShareMeta.js'

// Copied into the function by `includeFiles` in vercel.json.
const SHELL_URL = new URL('../dist/index.html', import.meta.url)

let shell = null
let supabase = null

function client() {
  supabase ??= createClient(
    process.env.VITE_SUPABASE_URL?.trim(),
    process.env.VITE_SUPABASE_ANON_KEY?.trim(),
    {
      auth: { persistSession: false },
      // The page waits for this read, so a slow Supabase costs 3 s at most
      // before the plain shell goes out.
      global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(3000) }) },
    },
  )
  return supabase
}

function send(res, html, cacheControl) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  for (const [k, v] of Object.entries(cacheControl)) res.setHeader(k, v)
  res.end(html)
}

const CACHED = {
  'Vercel-CDN-Cache-Control': 'max-age=300, stale-while-revalidate=86400, stale-if-error=86400',
  'Cache-Control': 'public, max-age=0, must-revalidate',
}

// The plain shell after an error is never cached: the next request tries again.
const NO_STORE = { 'Cache-Control': 'no-store' }

export default async function handler(req, res) {
  shell ??= readFileSync(SHELL_URL, 'utf8')
  const params = new URL(req.url, 'http://localhost').searchParams
  const slug = params.get('slug')
  // ?z=1: the link a runner shares from the registration page.
  const signedUp = params.get('z') === '1'
  // Anything this cannot describe still gets the app, which shows its own
  // "not found": the page must never break because the preview could not be made.
  if (!isEventSlug(slug)) return send(res, shell, CACHED)
  try {
    const fields = await readEventShareFields(client(), slug)
    send(res, fields ? injectShareMeta(shell, fields, slug, { signedUp }) : shell, CACHED)
  } catch (err) {
    console.error(`[api/event-page] ${slug}: ${err.message}`)
    send(res, shell, NO_STORE)
  }
}
