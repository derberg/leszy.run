// GET /api/startlist?event=<event id>: a registration event's public start
// list (RA8's columns) as one JSON document, built by start_list() in Supabase
// and cached by Vercel's CDN. Same model as api/event.js: the CDN answers the
// viewers, Supabase sees about one request per event per minute per CDN
// region, and no public page queries Supabase per viewer.
//
// Imports by relative path only: Vite's @registration alias does not exist
// inside a Vercel Function.
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// One lowercase spelling of an event id, so the CDN keeps one entry per event.
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
// 10 minutes while a refresh runs or fails (see api/event.js).
const CACHED = {
  'Vercel-CDN-Cache-Control': 'max-age=60, stale-while-revalidate=600, stale-if-error=600',
  'Cache-Control': 'public, max-age=0, must-revalidate',
}

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams
  const eventId = params.get('event')
  if ([...params.keys()].length !== 1 || !eventId || !EVENT_ID.test(eventId)) {
    return send(res, 400, { error: 'expected ?event=<event id> and nothing else' }, NO_STORE)
  }
  try {
    const { data, error } = await client().rpc('start_list', { p_event_id: eventId })
    if (error) throw new Error(error.message)
    if (!data) return send(res, 404, { error: 'not found' }, CACHED)
    // Changes only when the data does, so a page can skip a re-render.
    const version = createHash('sha1').update(JSON.stringify(data)).digest('hex')
    send(res, 200, { version, generatedAt: new Date().toISOString(), ...data }, { ...CACHED, ETag: `"${version}"` })
  } catch (err) {
    console.error(`[api/startlist] ${eventId}: ${err.message}`)
    send(res, 502, { error: 'start list unavailable' }, NO_STORE)
  }
}
