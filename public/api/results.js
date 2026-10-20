// GET /api/results?event=<event id>: the event's public results as one JSON
// document, built from Supabase and cached by Vercel's CDN.
//
// Public pages read this instead of querying Supabase per tab or subscribing to
// Postgres Changes. Supabase authorizes every change once per subscriber on a
// single thread, so that load grows with the viewer count and a bigger instance
// does not raise it. Here the CDN answers the viewers, and Supabase sees about
// one request per event every 5 s per CDN region.
import { createClient } from '@supabase/supabase-js'
import { buildResultsSnapshot } from '../src/lib/resultsSnapshot.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let supabase = null

function client() {
  supabase ??= createClient(
    process.env.VITE_SUPABASE_URL?.trim(),
    process.env.VITE_SUPABASE_ANON_KEY?.trim(),
    { auth: { persistSession: false } },
  )
  return supabase
}

function send(res, status, body, headers) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

// An error is never cached: the next request retries Supabase, and while the
// CDN still holds a good copy, stale-while-revalidate keeps serving it.
const NO_STORE = { 'Cache-Control': 'no-store' }

const CACHED = {
  // Vercel's CDN reads this header and strips it before the response leaves.
  'Vercel-CDN-Cache-Control': 'max-age=5, stale-while-revalidate=30',
  // The browser always asks again, so a poll never reuses its own old copy.
  'Cache-Control': 'public, max-age=0, must-revalidate',
}

export default async function handler(req, res) {
  // The CDN keys its cache on the whole query string. Accepting only one
  // spelling of it keeps one entry per event, so a request cannot skip the
  // cache by adding a parameter or changing the id's case.
  const params = new URL(req.url, 'http://localhost').searchParams
  const eventId = params.get('event')
  if ([...params.keys()].length !== 1 || !eventId || !UUID.test(eventId)) {
    return send(res, 400, { error: 'expected ?event=<lowercase event id> and nothing else' }, NO_STORE)
  }
  try {
    send(res, 200, await buildResultsSnapshot(client(), eventId), CACHED)
  } catch (err) {
    console.error(`[api/results] ${eventId}: ${err.message}`)
    send(res, 502, { error: 'results unavailable' }, NO_STORE)
  }
}
