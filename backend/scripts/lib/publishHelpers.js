// Shared by the publish scripts (publish-event-pages, publish-landing-pages,
// publish-leszyrun-events), which upload the public site's data to Supabase
// Storage. Storage access itself is public/scripts/lib/publicData.js.

import { existsSync } from 'fs'
import { resolve } from 'path'
import { stampDataVersion } from '../../../public/scripts/lib/publicData.js'

/**
 * Record a publish in public/data-version.json, the tracked file whose commit
 * deploys the site. Skipped (returns null) where the repository's public/ app
 * is absent, e.g. inside the scheduler's backend container.
 * @returns {string | null} the file written
 */
export function stampPublish(projectRoot, name, count, now = new Date()) {
  if (!existsSync(resolve(projectRoot, 'public/package.json'))) {
    console.log(`  (no public/ app at ${projectRoot}: data-version.json not stamped)`)
    return null
  }
  const file = resolve(projectRoot, 'public/data-version.json')
  stampDataVersion(file, name, count, now)
  return file
}

/**
 * Which kalendarz OG images to draw: every one with --regen-og, else new and
 * changed events plus unchanged ones whose image is missing from the bucket.
 * @param {{ newSlugs: string[], added: string[], changed: string[], existingOg: Set<string>, regenOg: boolean }} p
 */
export function ogSlugsToGenerate({ newSlugs, added, changed, existingOg, regenOg }) {
  if (regenOg) return [...newSlugs]
  const fresh = new Set([...added, ...changed])
  const missing = newSlugs.filter(s => !fresh.has(s) && !existingOg.has(s))
  return [...added, ...changed, ...missing]
}
