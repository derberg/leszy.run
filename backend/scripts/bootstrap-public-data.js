// One-off: upload the calendar manifests and OG images that used to be committed
// to git into Supabase Storage, so the first build after the move has data.
//
// Usage: cd backend && node --env-file=../.env scripts/bootstrap-public-data.js [--ref <git-ref>] [--apply]
//
// Reads the files from git, not from the working tree, because after the move
// they are no longer at HEAD:
//   public/public/kalendarz/.manifest.json  → calendar-manifests/kalendarz.json
//   public/public/listy/.manifest.json      → calendar-manifests/listy.json
//   public/public/events/.manifest.json     → calendar-manifests/events.json
//   public/public/kalendarz/<slug>/og.png   → calendar-og/kalendarz/<slug>/og.png
//
// --ref defaults to the last commit that still had the kalendarz manifest (the
// parent of the commit that removed it). Dry run by default: prints what it
// would upload. --apply uploads, then stamps public/data-version.json; commit
// that file to deploy. Re-running is safe: every upload replaces the object.
//
// Afterwards the publish scripts keep Storage current on their own
// (publish-event-pages.js, publish-landing-pages.js, publish-leszyrun-events.js).

import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  storageConfig, uploadObject, uploadOg, mapLimit, manifestCount,
  MANIFESTS, MANIFEST_BUCKET, OG_BUCKET,
} from '../../public/scripts/lib/publicData.js'
import { stampPublish } from './lib/publishHelpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const KALENDARZ_MANIFEST = 'public/public/kalendarz/.manifest.json'
const PATHS = ['public/public/kalendarz', 'public/public/listy/.manifest.json', 'public/public/events/.manifest.json']

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const refArg = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : null

function git(...a) {
  return execFileSync('git', ['-C', PROJECT_ROOT, ...a], { encoding: 'utf-8', maxBuffer: 1 << 30 }).trim()
}

function defaultRef() {
  try {
    git('cat-file', '-e', `HEAD:${KALENDARZ_MANIFEST}`)
    return 'HEAD'
  } catch {}
  // The newest commit that touched the manifest is the one that deleted it.
  const removing = git('log', '-1', '--format=%H', 'HEAD', '--', KALENDARZ_MANIFEST)
  if (!removing) throw new Error(`No commit in history has ${KALENDARZ_MANIFEST}; pass --ref`)
  return `${removing}^`
}

async function main() {
  const ref = refArg || defaultRef()
  const sha = git('rev-parse', '--short', ref)
  console.log(`${dryRun ? '=== DRY RUN (use --apply to upload) ===\n' : ''}Reading the committed data at ${ref} (${sha})`)

  const cfg = storageConfig()
  const work = mkdtempSync(join(tmpdir(), 'leszy-bootstrap-'))
  try {
    // git archive | tar -x: every file at that commit, without touching the checkout.
    const tar = execFileSync('git', ['-C', PROJECT_ROOT, 'archive', '--format=tar', ref, ...PATHS], { maxBuffer: 1 << 30 })
    execFileSync('tar', ['-x', '-C', work], { input: tar, maxBuffer: 1 << 30 })

    const manifests = {}
    for (const [name, { localPath }] of Object.entries(MANIFESTS)) {
      const file = join(work, 'public', localPath)
      if (!existsSync(file)) throw new Error(`${localPath} is not in ${ref}`)
      const body = readFileSync(file)
      manifests[name] = { body, count: manifestCount(JSON.parse(body.toString('utf-8'))) }
      console.log(`  ${name}: ${manifests[name].count} entries → ${MANIFEST_BUCKET}/${MANIFESTS[name].object}`)
    }

    const kalendarzDir = join(work, 'public/public/kalendarz')
    const kalendarz = JSON.parse(manifests.kalendarz.body.toString('utf-8'))
    const slugs = readdirSync(kalendarzDir).filter(s => {
      const png = join(kalendarzDir, s, 'og.png')
      return existsSync(png) && statSync(png).isFile()
    })
    const orphans = slugs.filter(s => !(s in kalendarz))
    console.log(`  OG images: ${slugs.length} → ${OG_BUCKET}/kalendarz/<slug>/og.png${orphans.length ? ` (${orphans.length} not in the manifest, uploaded anyway)` : ''}`)
    const withoutImage = Object.keys(kalendarz).filter(s => !slugs.includes(s))
    if (withoutImage.length) console.log(`  ${withoutImage.length} manifest entries have no image; the next publish-event-pages.js --apply draws them`)

    if (dryRun) { console.log('\nDry run complete. Use --apply to upload.'); return }

    let done = 0
    const failed = []
    await mapLimit(slugs, 8, async slug => {
      try {
        await uploadOg(cfg, slug, readFileSync(join(kalendarzDir, slug, 'og.png')))
      } catch (err) {
        failed.push({ slug, message: err.message })
      }
      done++
      if (done % 250 === 0) console.log(`  uploaded ${done}/${slugs.length} images`)
    })
    // A few uploads still fail at the network level after uploadObject's own
    // retries when 8 run at once (measured 2026-11-08: 4 of 3035); sent one at a
    // time they go through, so the leftovers get a last pass on their own.
    if (failed.length) {
      console.log(`  ${failed.length} images failed; sending them again one at a time`)
      const leftovers = failed.splice(0)
      for (const { slug } of leftovers) {
        try {
          await uploadOg(cfg, slug, readFileSync(join(kalendarzDir, slug, 'og.png')))
        } catch (err) {
          failed.push({ slug, message: err.message })
        }
      }
    }
    if (failed.length) {
      for (const f of failed.slice(0, 20)) console.error(`  ${f.slug}: ${f.message}`)
      throw new Error(`${failed.length} image uploads failed; re-run the same command (uploads replace)`)
    }
    console.log(`  uploaded ${slugs.length} images`)

    // Manifests last: a build never sees a manifest whose images are missing.
    for (const [name, { body, count }] of Object.entries(manifests)) {
      await uploadObject(cfg, MANIFEST_BUCKET, MANIFESTS[name].object, body, 'application/json', { cacheControl: 60 })
      stampPublish(PROJECT_ROOT, name, count)
      console.log(`  uploaded ${MANIFEST_BUCKET}/${MANIFESTS[name].object}`)
    }
    console.log(`\nDone. Commit public/data-version.json to deploy.`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
