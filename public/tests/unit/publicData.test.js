import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  storageConfig, downloadObject, uploadObject, listFolder, removeObjects,
  readManifest, writeManifest, stampDataVersion, mapLimit, uploadRetry, MANIFEST_BUCKET, OG_BUCKET,
} from '../../scripts/lib/publicData.js'
import { validateManifest, fetchManifests, stripDist } from '../../scripts/fetch-manifests.js'

// The calendar manifests left git for a private Storage bucket. The build must
// get every one of them or fail: a build that carried on without one would
// deploy a site with no calendar.

const cfg = { url: 'http://storage.test', key: 'service-key' }

/** A fake fetch: `routes` maps "METHOD path" to a Response factory; every call is recorded. */
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET'
    const path = new URL(url).pathname
    calls.push({ method, path, init })
    const handler = routes[`${method} ${path}`]
    if (!handler) return new Response('{"statusCode":"404","error":"not_found"}', { status: 400 })
    return handler(init)
  }
  fn.calls = calls
  return fn
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

test('storageConfig requires the service role key, never falls back to the anon key', () => {
  assert.throws(() => storageConfig({ SUPABASE_URL: 'http://x', VITE_SUPABASE_ANON_KEY: 'anon' }), /SUPABASE_SERVICE_ROLE_KEY/)
  assert.throws(() => storageConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k' }), /SUPABASE_URL/)
  assert.deepEqual(storageConfig({ VITE_SUPABASE_URL: 'http://x/', SUPABASE_SERVICE_ROLE_KEY: 'k' }), { url: 'http://x', key: 'k' })
})

test('a missing object is null, in both shapes Storage answers it; any other failure throws', async () => {
  const f = fakeFetch({
    'GET /storage/v1/object/b/gone-404': () => new Response('nope', { status: 404 }),
    'GET /storage/v1/object/b/broken': () => new Response('boom', { status: 500 }),
    'GET /storage/v1/object/b/denied': () => new Response('{"error":"Unauthorized"}', { status: 400 }),
  })
  assert.equal(await downloadObject(cfg, 'b', 'gone-400', f), null)
  assert.equal(await downloadObject(cfg, 'b', 'gone-404', f), null)
  await assert.rejects(downloadObject(cfg, 'b', 'broken', f), /HTTP 500/)
  await assert.rejects(downloadObject(cfg, 'b', 'denied', f), /HTTP 400/)
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer service-key')
})

test('upload replaces the object and names its type', async () => {
  const f = fakeFetch({ 'POST /storage/v1/object/calendar-og/kalendarz/a/og.png': () => json({}) })
  await uploadObject(cfg, OG_BUCKET, 'kalendarz/a/og.png', Buffer.from('png'), 'image/png', {}, f)
  const h = f.calls[0].init.headers
  assert.equal(h['x-upsert'], 'true')
  assert.equal(h['content-type'], 'image/png')
})

// Measured 2026-11-08: 2-3 % of uploads from the operator's Mac fail at the
// network level ("fetch failed", cause UND_ERR_SOCKET or ERR_SSL_*_BAD_RECORD_MAC),
// at any concurrency, and succeed on another try. Nothing reached Storage, and
// the upload is an upsert, so sending again is safe.
uploadRetry.backoffMs = 0

function socketClosed() {
  const err = new TypeError('fetch failed')
  err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  return err
}

test('an upload whose connection was closed under it is sent again', async () => {
  let n = 0
  const f = async () => { n++; if (n < 3) throw socketClosed(); return json({}) }
  await uploadObject(cfg, OG_BUCKET, 'kalendarz/a/og.png', Buffer.from('png'), 'image/png', {}, f)
  assert.equal(n, 3)
})

test('a TLS record damaged in transit is retried too', async () => {
  let n = 0
  const f = async () => {
    n++
    if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('bad record mac'), { code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' }) })
    return json({})
  }
  await uploadObject(cfg, OG_BUCKET, 'kalendarz/a/og.png', Buffer.from('png'), 'image/png', {}, f)
  assert.equal(n, 2)
})

test('an upload gives up after 6 closed connections and says why', async () => {
  let n = 0
  const f = async () => { n++; throw socketClosed() }
  await assert.rejects(uploadObject(cfg, OG_BUCKET, 'kalendarz/a/og.png', Buffer.from('png'), 'image/png', {}, f), /fetch failed/)
  assert.equal(n, 6)
})

test('an HTTP refusal or any other error is never retried', async () => {
  const refused = fakeFetch({ 'POST /storage/v1/object/calendar-og/kalendarz/a/og.png': () => json({ error: 'nope' }, 403) })
  await assert.rejects(uploadObject(cfg, OG_BUCKET, 'kalendarz/a/og.png', Buffer.from('png'), 'image/png', {}, refused), /HTTP 403/)
  assert.equal(refused.calls.length, 1)
  let n = 0
  const other = async () => { n++; throw new Error('boom') }
  await assert.rejects(uploadObject(cfg, OG_BUCKET, 'kalendarz/a/og.png', Buffer.from('png'), 'image/png', {}, other), /boom/)
  assert.equal(n, 1)
})

test('listFolder pages until a short page', async () => {
  const pages = [[{ name: 'a' }, { name: 'b' }], [{ name: 'c' }, { name: 'd' }], [{ name: 'e' }]]
  const f = fakeFetch({
    'POST /storage/v1/object/list/calendar-og': init => json(pages[JSON.parse(init.body).offset / 2]),
  })
  assert.deepEqual(await listFolder(cfg, OG_BUCKET, 'kalendarz', f, 2), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(f.calls.length, 3)
})

test('removeObjects sends the paths in chunks', async () => {
  const f = fakeFetch({ 'DELETE /storage/v1/object/calendar-og': () => json([]) })
  await removeObjects(cfg, OG_BUCKET, ['1', '2', '3'], f, 2)
  assert.deepEqual(f.calls.map(c => JSON.parse(c.init.body).prefixes), [['1', '2'], ['3']])
})

test('readManifest: null when never published, the object when it is; writeManifest uploads JSON to the private bucket', async () => {
  const stored = {}
  const f = fakeFetch({
    [`POST /storage/v1/object/${MANIFEST_BUCKET}/kalendarz.json`]: init => { stored.body = init.body; stored.type = init.headers['content-type']; return json({}) },
  })
  assert.equal(await readManifest(cfg, 'kalendarz', f), null)
  await writeManifest(cfg, 'kalendarz', { 'bieg-2026-01-01': { name: 'Bieg' } }, f)
  assert.equal(stored.type, 'application/json')
  const g = fakeFetch({ [`GET /storage/v1/object/${MANIFEST_BUCKET}/kalendarz.json`]: () => new Response(stored.body) })
  assert.deepEqual(await readManifest(cfg, 'kalendarz', g), { 'bieg-2026-01-01': { name: 'Bieg' } })
})

test('data-version.json keeps one timestamp and count per manifest and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dv-'))
  const file = join(dir, 'data-version.json')
  stampDataVersion(file, 'listy', 745, new Date('2026-11-04T08:00:00Z'))
  stampDataVersion(file, 'kalendarz', 3035, new Date('2026-11-04T09:00:00Z'))
  const v = JSON.parse(readFileSync(file, 'utf-8'))
  assert.deepEqual(Object.keys(v), ['kalendarz', 'listy'])
  assert.deepEqual(v.kalendarz, { publishedAt: '2026-11-04T09:00:00.000Z', count: 3035 })
  assert.deepEqual(v.listy, { publishedAt: '2026-11-04T08:00:00.000Z', count: 745 })
  rmSync(dir, { recursive: true })
})

test('mapLimit runs every item with bounded concurrency', async () => {
  let running = 0, peak = 0
  const seen = []
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    running++; peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 2))
    seen.push(n); running--
  })
  assert.equal(peak, 3)
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7])
})

test('validateManifest refuses a missing, malformed or empty calendar', () => {
  assert.throws(() => validateManifest('kalendarz', null), /not in bucket/)
  assert.throws(() => validateManifest('kalendarz', Buffer.from('{oops')), /not valid JSON/)
  assert.throws(() => validateManifest('kalendarz', Buffer.from('{}')), /empty/)
  assert.throws(() => validateManifest('listy', Buffer.from('{}')), /empty/)
  assert.deepEqual(validateManifest('events', Buffer.from('{}')), {})
  assert.deepEqual(validateManifest('kalendarz', Buffer.from('{"a":{}}')), { a: {} })
})

function manifestRoutes(bodies) {
  const routes = {}
  for (const [obj, body] of Object.entries(bodies)) {
    routes[`GET /storage/v1/object/${MANIFEST_BUCKET}/${obj}`] = () => new Response(body)
  }
  return routes
}

test('fetchManifests writes every manifest where the generators read it', async () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'fm-'))
  const f = fakeFetch(manifestRoutes({
    'kalendarz.json': '{"a":{"name":"A"},"b":{"name":"B"}}',
    'listy.json': '{"listy":{"h1":"Biegi"}}',
    'events.json': '{}',
  }))
  const report = await fetchManifests({ cfg, appRoot, fetchImpl: f })
  assert.deepEqual(report.map(r => [r.name, r.count]), [['kalendarz', 2], ['listy', 1], ['events', 0]])
  assert.deepEqual(JSON.parse(readFileSync(join(appRoot, 'public/kalendarz/.manifest.json'), 'utf-8')), { a: { name: 'A' }, b: { name: 'B' } })
  assert.ok(existsSync(join(appRoot, 'public/listy/.manifest.json')))
  assert.ok(existsSync(join(appRoot, 'public/events/.manifest.json')))
  rmSync(appRoot, { recursive: true })
})

test('fetchManifests fails when one manifest is missing, and the build stops', async () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'fm-'))
  const f = fakeFetch(manifestRoutes({ 'kalendarz.json': '{"a":{}}', 'events.json': '{}' }))
  await assert.rejects(fetchManifests({ cfg, appRoot, fetchImpl: f }), /listy\.json is not in bucket/)
  rmSync(appRoot, { recursive: true })
})

test('dev mode keeps manifests already on disk', async () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'fm-'))
  mkdirSync(join(appRoot, 'public/listy'), { recursive: true })
  writeFileSync(join(appRoot, 'public/listy/.manifest.json'), '{"local":{}}')
  const f = fakeFetch(manifestRoutes({ 'kalendarz.json': '{"a":{}}', 'listy.json': '{"remote":{}}', 'events.json': '{}' }))
  const report = await fetchManifests({ cfg, appRoot, onlyMissing: true, fetchImpl: f })
  assert.equal(report.find(r => r.name === 'listy').skipped, true)
  assert.equal(readFileSync(join(appRoot, 'public/listy/.manifest.json'), 'utf-8'), '{"local":{}}')
  rmSync(appRoot, { recursive: true })
})

test('stripDist removes the kalendarz and events manifests from dist, keeps listy (the /listy pages fetch it)', () => {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'))
  for (const p of ['kalendarz', 'events', 'listy']) {
    mkdirSync(join(dist, p), { recursive: true })
    writeFileSync(join(dist, p, '.manifest.json'), '{}')
  }
  assert.deepEqual(stripDist(dist).sort(), ['events/.manifest.json', 'kalendarz/.manifest.json'])
  assert.ok(!existsSync(join(dist, 'kalendarz/.manifest.json')))
  assert.ok(!existsSync(join(dist, 'events/.manifest.json')))
  assert.ok(existsSync(join(dist, 'listy/.manifest.json')))
  rmSync(dist, { recursive: true })
})
