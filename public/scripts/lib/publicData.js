// Where the public site's calendar data lives, and how it gets there.
//
// The three manifests (kalendarz, listy, events) and the kalendarz OG images
// used to be committed to git. The repository is public, so `git clone` handed
// out the whole race calendar. They now live in Supabase Storage:
//
//   calendar-manifests  PRIVATE bucket, service role only. One JSON object per
//                       manifest. Written by the publish scripts on the
//                       operator's host (backend/scripts/publish-*.js --apply),
//                       read by the Vercel build (public/scripts/fetch-manifests.js).
//   calendar-og         PUBLIC bucket. kalendarz/<slug>/og.png, served at the
//                       unchanged address https://www.leszy.run/kalendarz/<slug>/og.png
//                       through a rewrite in public/vercel.json.
//
// What triggers a deploy is public/data-version.json, a tracked file the
// publish scripts rewrite with a timestamp and a count per manifest. The
// operator commits it; the commit deploys; the build downloads the manifests.
//
// Plain fetch against the Storage REST API, no supabase-js: this module is
// imported by the backend publish scripts and by the public build, and the
// tests drive it with a fake fetch.

import { readFileSync, writeFileSync, existsSync } from 'fs'

export const MANIFEST_BUCKET = 'calendar-manifests'
export const OG_BUCKET = 'calendar-og'

/** Each manifest: its object in MANIFEST_BUCKET and its path under public/ (the app root). */
export const MANIFESTS = {
  kalendarz: { object: 'kalendarz.json', localPath: 'public/kalendarz/.manifest.json' },
  listy: { object: 'listy.json', localPath: 'public/listy/.manifest.json' },
  events: { object: 'events.json', localPath: 'public/events/.manifest.json' },
}

/** Manifests the build must not copy into dist/: nothing in the browser reads them. */
export const UNSERVED_MANIFESTS = ['kalendarz', 'events']

export const OG_PREFIX = 'kalendarz'

export function ogObjectPath(slug) {
  return `${OG_PREFIX}/${slug}/og.png`
}

/**
 * Storage settings from the environment. The service role key is required:
 * the manifest bucket has no policy for any other role.
 * @returns {{ url: string, key: string }}
 */
export function storageConfig(env = process.env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const key = env.SUPABASE_SERVICE_ROLE_KEY || ''
  const missing = []
  if (!url) missing.push('SUPABASE_URL (or VITE_SUPABASE_URL)')
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length) {
    const err = new Error(`Missing ${missing.join(' and ')}. The calendar manifests live in the private Supabase Storage bucket "${MANIFEST_BUCKET}", which only the service role can read or write.`)
    err.code = 'missing_env'
    throw err
  }
  return { url, key }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function authHeaders(cfg) {
  return { authorization: `Bearer ${cfg.key}`, apikey: cfg.key }
}

async function failure(res, what) {
  let body = ''
  try { body = (await res.text()).slice(0, 300) } catch {}
  const err = new Error(`${what}: HTTP ${res.status} ${body}`.trim())
  err.status = res.status
  return err
}

// Storage answers a missing object with 404, or (older storage-api) 400 with
// a body naming not_found.
async function isNotFound(res) {
  if (res.status === 404) return true
  if (res.status !== 400) return false
  try {
    const text = await res.clone().text()
    return /not[_ ]found/i.test(text)
  } catch { return false }
}

/**
 * Download one object. Returns its bytes, or null when the object does not exist.
 * Any other failure throws.
 */
export async function downloadObject(cfg, bucket, path, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.url}/storage/v1/object/${bucket}/${encodePath(path)}`, {
    headers: authHeaders(cfg),
  })
  if (res.ok) return Buffer.from(await res.arrayBuffer())
  if (await isNotFound(res)) return null
  throw await failure(res, `Download ${bucket}/${path} failed`)
}

/** Upload (create or replace) one object. */
export async function uploadObject(cfg, bucket, path, body, contentType, { cacheControl = 3600 } = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.url}/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'content-type': contentType,
      'cache-control': `max-age=${cacheControl}`,
      'x-upsert': 'true',
    },
    body,
  })
  if (!res.ok) throw await failure(res, `Upload ${bucket}/${path} failed`)
}

/**
 * Names directly under a folder (files and sub-folders), paginated: Storage
 * returns at most `pageSize` entries per call.
 */
export async function listFolder(cfg, bucket, prefix, fetchImpl = fetch, pageSize = 1000) {
  const names = []
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetchImpl(`${cfg.url}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    if (!res.ok) throw await failure(res, `List ${bucket}/${prefix} failed`)
    const page = await res.json()
    for (const item of page) names.push(item.name)
    if (page.length < pageSize) break
  }
  return names
}

/** Delete objects, at most `chunk` per request. */
export async function removeObjects(cfg, bucket, paths, fetchImpl = fetch, chunk = 500) {
  for (let i = 0; i < paths.length; i += chunk) {
    const res = await fetchImpl(`${cfg.url}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.slice(i, i + chunk) }),
    })
    if (!res.ok) throw await failure(res, `Delete from ${bucket} failed`)
  }
}

/**
 * The published manifest, or null when none was ever uploaded.
 * A manifest that exists but does not parse throws: a publish run must not
 * mistake it for "nothing published yet" and redraw every image.
 */
export async function readManifest(cfg, name, fetchImpl = fetch) {
  const buf = await downloadObject(cfg, MANIFEST_BUCKET, MANIFESTS[name].object, fetchImpl)
  if (buf === null) return null
  return JSON.parse(buf.toString('utf-8'))
}

export async function writeManifest(cfg, name, manifest, fetchImpl = fetch) {
  const body = JSON.stringify(manifest, null, 2)
  await uploadObject(cfg, MANIFEST_BUCKET, MANIFESTS[name].object, body, 'application/json', { cacheControl: 60 }, fetchImpl)
  return body.length
}

/** Slugs that have an OG image folder in the public bucket. */
export async function listOgSlugs(cfg, fetchImpl = fetch) {
  return new Set(await listFolder(cfg, OG_BUCKET, OG_PREFIX, fetchImpl))
}

export async function uploadOg(cfg, slug, png, fetchImpl = fetch) {
  await uploadObject(cfg, OG_BUCKET, ogObjectPath(slug), png, 'image/png', { cacheControl: 3600 }, fetchImpl)
}

export async function removeOgs(cfg, slugs, fetchImpl = fetch) {
  await removeObjects(cfg, OG_BUCKET, slugs.map(ogObjectPath), fetchImpl)
}

/** Number of entries in a manifest, whether it is an object or an array. */
export function manifestCount(manifest) {
  if (Array.isArray(manifest)) return manifest.length
  return Object.keys(manifest || {}).length
}

/**
 * Record a publish in public/data-version.json, the tracked file whose commit
 * deploys the site. Holds a timestamp and a count per manifest, nothing else.
 * @param {string} file absolute path of data-version.json
 */
export function stampDataVersion(file, name, count, now = new Date()) {
  let current = {}
  if (existsSync(file)) {
    try { current = JSON.parse(readFileSync(file, 'utf-8')) } catch { current = {} }
  }
  const next = { ...current, [name]: { publishedAt: now.toISOString(), count } }
  const ordered = {}
  for (const key of Object.keys(next).sort()) ordered[key] = next[key]
  writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n')
  return ordered
}

/** Run `fn` over `items` with at most `limit` running at once. */
export async function mapLimit(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}
