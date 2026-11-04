// Downloads the calendar manifests from Supabase Storage before the build.
//
// Usage (from public/):
//   node scripts/fetch-manifests.js              build: every manifest or a failed build
//   node scripts/fetch-manifests.js --dev        dev server: skip what is already on disk,
//                                                warn instead of failing
//   node scripts/fetch-manifests.js --strip-dist after `vite build`: delete the manifests
//                                                nothing in the browser reads from dist/
//
// The manifests are no longer in git (see scripts/lib/publicData.js). They are
// written to the same paths the generators always read, which .gitignore keeps
// out of the repository. The build FAILS when it cannot get one: an empty
// manifest would deploy a site with no calendar and no /kalendarz pages.
//
// Env: SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY, from
// the Vercel project's environment, or from the repo-root .env locally.

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  MANIFESTS, MANIFEST_BUCKET, UNSERVED_MANIFESTS,
  storageConfig, downloadObject, manifestCount,
} from './lib/publicData.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
const REPO_ENV = resolve(APP_ROOT, '..', '.env')

/** Manifests that may never be empty: the site is the calendar. */
const MUST_HAVE_ENTRIES = new Set(['kalendarz', 'listy'])

/**
 * Check a downloaded manifest. Returns the parsed value or throws with the reason.
 */
export function validateManifest(name, buf) {
  if (buf === null) {
    throw new Error(`${MANIFESTS[name].object} is not in bucket "${MANIFEST_BUCKET}". Publish it first (backend/scripts/publish-*.js --apply, or bootstrap-public-data.js --apply).`)
  }
  let parsed
  try { parsed = JSON.parse(buf.toString('utf-8')) } catch (err) {
    throw new Error(`${MANIFESTS[name].object} is not valid JSON: ${err.message}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${MANIFESTS[name].object} is not a JSON object`)
  }
  if (MUST_HAVE_ENTRIES.has(name) && manifestCount(parsed) === 0) {
    throw new Error(`${MANIFESTS[name].object} is empty; refusing to build a site with no ${name} pages`)
  }
  return parsed
}

/**
 * Download every manifest to its local path.
 * @returns {Promise<{ name: string, count: number, bytes: number, skipped?: boolean }[]>}
 */
export async function fetchManifests({ cfg, appRoot = APP_ROOT, onlyMissing = false, fetchImpl = fetch } = {}) {
  const report = []
  for (const [name, { object, localPath }] of Object.entries(MANIFESTS)) {
    const target = resolve(appRoot, localPath)
    if (onlyMissing && existsSync(target)) {
      report.push({ name, skipped: true })
      continue
    }
    const buf = await downloadObject(cfg, MANIFEST_BUCKET, object, fetchImpl)
    const parsed = validateManifest(name, buf)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buf)
    report.push({ name, count: manifestCount(parsed), bytes: buf.length })
  }
  return report
}

/** Remove the manifests from dist/ that no page fetches, so the site does not serve the dataset. */
export function stripDist(distDir) {
  const removed = []
  for (const name of UNSERVED_MANIFESTS) {
    // localPath is relative to the app root and starts with public/; dist mirrors what follows.
    const rel = MANIFESTS[name].localPath.replace(/^public\//, '')
    const file = resolve(distDir, rel)
    if (existsSync(file)) { rmSync(file); removed.push(rel) }
  }
  return removed
}

function loadRepoEnv() {
  if (!existsSync(REPO_ENV) || typeof process.loadEnvFile !== 'function') return
  // Values already in the environment (Vercel's) win over the file.
  process.loadEnvFile(REPO_ENV)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--strip-dist')) {
    const removed = stripDist(resolve(APP_ROOT, 'dist'))
    console.log(`fetch-manifests: removed from dist/: ${removed.join(', ') || 'nothing'}`)
    return
  }

  const dev = args.includes('--dev')
  if (dev && Object.values(MANIFESTS).every(m => existsSync(resolve(APP_ROOT, m.localPath)))) {
    console.log('fetch-manifests: manifests already on disk (run `npm run fetch-manifests` to refresh)')
    return
  }
  loadRepoEnv()

  let cfg
  try {
    cfg = storageConfig()
  } catch (err) {
    if (dev) {
      console.warn(`fetch-manifests: ${err.message}\n  The dev server starts anyway; /kalendarz and /listy pages that read a manifest will be empty. Add the key to the repo-root .env and run: node scripts/fetch-manifests.js`)
      return
    }
    console.error(`fetch-manifests: ${err.message}\n  Set SUPABASE_SERVICE_ROLE_KEY in the Vercel project's environment (Production and Preview), or in the repo-root .env for a local build. The build stops here so an empty calendar is never deployed.`)
    process.exit(1)
  }

  try {
    const report = await fetchManifests({ cfg, onlyMissing: dev })
    for (const r of report) {
      if (r.skipped) console.log(`fetch-manifests: ${r.name} already on disk, kept`)
      else console.log(`fetch-manifests: ${r.name} ${r.count} entries, ${(r.bytes / 1024).toFixed(0)} KB`)
    }
  } catch (err) {
    if (dev) {
      console.warn(`fetch-manifests: ${err.message}\n  The dev server starts anyway, without that manifest.`)
      return
    }
    console.error(`fetch-manifests: ${err.message} (Storage at ${cfg.url})\n  The build stops here so an empty or partial calendar is never deployed.`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
