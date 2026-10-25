import { readdir, rm, stat } from 'fs/promises'
import path from 'path'
import postgres from 'postgres'

// Purge camera evidence — the PHOTOGRAPHS first, then the rows.
//
// Retention is 30 days, not the 90 days gate_events gets. A photograph of a
// person is more sensitive than a tag read, and its usefulness ends once the
// results are final. This is the automatic purge the ROPA entry promises; a
// retention period nobody enforces is not a retention period.
//
// Deleting the rows alone would be the wrong half. The rows are small and the
// frames are tens of gigabytes, and it is the frames that carry the faces. So
// the files go first, and the rows only after, which means an interrupted run
// leaves rows pointing at missing files — recoverable and visible — rather
// than orphaned photographs nothing refers to any more.
//
// Usage:
//   node --env-file=../.env scripts/purge-vision-evidence.js            # report
//   node --env-file=../.env scripts/purge-vision-evidence.js --apply    # delete

const RETENTION_DAYS = parseInt(process.env.VISION_RETENTION_DAYS || '30', 10)
const apply = process.argv.includes('--apply')

const sql = postgres(
  process.env.DATABASE_URL || 'postgres://leszyrun:leszyrun@localhost:5432/leszyrun',
)

/** Frames, crops and the done/ spool. Never the session.json or the logs. */
async function purgeImages(queueDir) {
  let removed = 0
  for (const sub of ['', 'done', 'crops']) {
    const dir = sub ? path.join(queueDir, sub) : queueDir
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.jpg')) continue
      const file = path.join(dir, name)
      try {
        const info = await stat(file)
        if (!info.isFile()) continue
        if (apply) await rm(file, { force: true })
        removed += 1
      } catch { /* already gone */ }
    }
  }
  return removed
}

async function main() {
  const expired = await sql`
    select s.id, s.queue_dir, s.label, s.started_at,
           (select count(*) from vision_sightings v where v.session_id = s.id) as sightings
      from vision_sessions s
     where s.started_at < now() - (${RETENTION_DAYS} || ' days')::interval
  `

  if (!expired.length) {
    console.log(`[purge-vision] nothing older than ${RETENTION_DAYS} days`)
    return
  }

  // A session whose queue directory this process cannot see is never deleted.
  // readdir() failing is otherwise indistinguishable from "no images", and the
  // rows would go while the photographs stayed: the scheduler runs this in a
  // one-shot container that mounts none of the frame directories.
  const missing = []
  for (const session of expired) {
    try {
      if (!(await stat(session.queue_dir)).isDirectory()) throw new Error('not a directory')
    } catch (err) {
      missing.push(session)
      console.error(
        `[purge-vision] SKIPPED ${session.label || session.id}: queue_dir ${session.queue_dir} ` +
        `is not reachable here (${err.code || err.message}). Run this where the frames live.`,
      )
    }
  }
  const reachable = expired.filter(s => !missing.includes(s))

  let images = 0
  for (const session of reachable) {
    const n = await purgeImages(session.queue_dir)
    images += n
    console.log(
      `[purge-vision] ${apply ? 'purged' : 'would purge'} ` +
      `${String(n).padStart(6)} images  ${session.sightings} sightings  ` +
      `${session.label || session.queue_dir}  (${session.started_at.toISOString().slice(0, 10)})`,
    )
  }

  if (apply) {
    // Only now: a crash before this point leaves rows pointing at missing
    // files, which is visible. The reverse leaves photographs nothing knows
    // about, which is not.
    if (reachable.length) {
      const ids = reachable.map(r => r.id)
      const deleted = await sql`delete from vision_sessions where id in ${sql(ids)}`
      console.log(`[purge-vision] deleted ${deleted.count} sessions, ${images} images`)
    }
  } else {
    console.log(
      `[purge-vision] DRY RUN — ${reachable.length} sessions, ${images} images. ` +
      'Pass --apply to delete.',
    )
  }
  return missing.length
}

let skipped = 0
main()
  .then((n) => { skipped = n || 0 })
  .then(() => sql.end())
  // A skipped session is a retention promise not kept: fail so it gets noticed.
  .then(() => process.exit(skipped ? 1 : 0))
  .catch((err) => {
    console.error('[purge-vision] error:', err)
    process.exit(1)
  })
