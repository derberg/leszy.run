import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { sameAtest } from '../src/lib/atestMatch.js'

// Usage: cd backend && node --env-file=../.env scripts/revert-atest.js <mode> [--apply]
//
// Takes back atests written by run-atest.js. Dry run by default: prints every
// row it would change. --apply writes.
//
//   --id <scraper_all id> [--id …]
//       This race must not show an atest. Nulls scraper_all.atest and
//       calendar_events.atest, and adds 'atest' to calendar_events.locked_fields.
//       The lock is what makes it stick: run-atest.js recomputes scraper_all.atest
//       on every run (the scheduler runs it daily), and run-publish.js leaves a
//       locked field alone. Use it for a wrong match the code still makes.
//
//   --id <scraper_all id> --unlock
//       Undoes the above: removes 'atest' from locked_fields. The next
//       run-atest.js + run-publish.js put back whatever the register decides.
//
//   --run-log logs/atest-<timestamp>.json [--lock]
//       Undoes one run: every row of the log's `changes` gets its `before` value
//       back, in scraper_all and calendar_events, but only where the row still
//       holds that run's `after` (a later run or a person changed it otherwise).
//       Without --lock the next run-atest.js writes the same values again, so
//       fix the matching code first, or pass --lock to keep each reverted
//       calendar_events row as it is now. Logs from before 2026-11-08 have no
//       `changes` list and are refused.
//
// calendar_events rows are found by the scraper_all row's source + source_id,
// as run-publish.js finds them (primary pair or any entry of source_links).

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const unlock = args.includes('--unlock')
const lock = args.includes('--lock')
const ids = args.flatMap((a, i) => (a === '--id' ? [args[i + 1]] : [])).filter(Boolean)
const runLogPath = args[args.indexOf('--run-log') + 1]
const useRunLog = args.includes('--run-log')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function usage(msg) {
  console.error(`[revert-atest] ${msg}\nUsage: revert-atest.js --id <scraper_all id> [--id …] [--unlock] | --run-log <file> [--lock]  [--apply]`)
  process.exit(2)
}

async function calendarRowsFor(source, sourceId) {
  if (!source || !sourceId) return []
  const cols = 'id, name, date, status, atest, locked_fields'
  const { data: primary, error } = await supabase.from('calendar_events').select(cols).eq('source', source).eq('source_id', sourceId)
  if (error) throw new Error(`calendar_events: ${error.message}`)
  const { data: linked, error: e2 } = await supabase.from('calendar_events').select(cols).contains('source_links', JSON.stringify([{ source, source_id: sourceId }]))
  if (e2) throw new Error(`calendar_events: ${e2.message}`)
  return [...new Map([...primary, ...linked].map((r) => [r.id, r])).values()]
}

const fmt = (a) => (Array.isArray(a) && a.length ? a.map((x) => `${x.km} km`).join(', ') : '—')

async function write(table, id, patch) {
  if (!apply) return
  const { error } = await supabase.from(table).update(patch).eq('id', id)
  if (error) throw new Error(`${table} ${id}: ${error.message}`)
}

function withLock(locked, on) {
  const set = new Set(Array.isArray(locked) ? locked : [])
  if (on) set.add('atest')
  else set.delete('atest')
  return [...set]
}

async function byId() {
  let n = 0
  for (const id of ids) {
    const { data: sa, error } = await supabase.from('scraper_all').select('id, name, date, source, source_id, atest').eq('id', id).maybeSingle()
    if (error) throw new Error(`scraper_all: ${error.message}`)
    if (!sa) { console.log(`  ? ${id}: no scraper_all row`); continue }
    console.log(`  [${sa.date}] ${sa.name} (${sa.source}:${sa.source_id})`)
    if (!unlock && sa.atest) {
      console.log(`    scraper_all.atest ${fmt(sa.atest)} → —`)
      await write('scraper_all', sa.id, { atest: null })
    }
    const ces = await calendarRowsFor(sa.source, sa.source_id)
    if (!ces.length) console.log('    no calendar_events row')
    for (const ce of ces) {
      const locked = withLock(ce.locked_fields, !unlock)
      if (unlock) {
        console.log(`    calendar_events ${ce.id}: unlock atest (now ${fmt(ce.atest)}; the next publish sets the register's decision)`)
        await write('calendar_events', ce.id, { locked_fields: locked })
      } else {
        console.log(`    calendar_events ${ce.id}: atest ${fmt(ce.atest)} → —, locked`)
        await write('calendar_events', ce.id, { atest: null, locked_fields: locked })
      }
      n++
    }
  }
  return n
}

async function byRunLog() {
  const log = JSON.parse(await readFile(runLogPath, 'utf8'))
  if (log.script !== 'atest') usage(`${runLogPath} is not a run-atest.js log`)
  if (!Array.isArray(log.changes)) usage(`${runLogPath} has no changes list (a run from before 2026-11-08): revert those rows with --id`)
  console.log(`[revert-atest] run of ${log.started_at}: ${log.changes.length} changed rows`)
  let n = 0
  for (const c of log.changes) {
    console.log(`  [${c.date}] ${c.name}: ${fmt(c.after)} → ${fmt(c.before)}`)
    const { data: sa, error } = await supabase.from('scraper_all').select('id, atest').eq('id', c.id).maybeSingle()
    if (error) throw new Error(`scraper_all: ${error.message}`)
    if (!sa) console.log('    scraper_all: row gone')
    else if (!sameAtest(sa.atest, c.after)) console.log(`    scraper_all: skipped, now ${fmt(sa.atest)}`)
    else { await write('scraper_all', sa.id, { atest: c.before }); n++ }
    for (const ce of await calendarRowsFor(c.source, c.source_id)) {
      if (!sameAtest(ce.atest, c.after)) { console.log(`    calendar_events ${ce.id}: skipped, now ${fmt(ce.atest)}`); continue }
      const patch = { atest: c.before }
      if (lock) patch.locked_fields = withLock(ce.locked_fields, true)
      console.log(`    calendar_events ${ce.id}: → ${fmt(c.before)}${lock ? ', locked' : ''}`)
      await write('calendar_events', ce.id, patch)
      n++
    }
  }
  return n
}

async function main() {
  if (useRunLog && ids.length) usage('use either --id or --run-log')
  if (useRunLog && (!runLogPath || runLogPath.startsWith('--'))) usage('--run-log needs a file')
  if (!useRunLog && !ids.length) usage('nothing to revert')
  if (unlock && useRunLog) usage('--unlock goes with --id')
  if (lock && !useRunLog) usage('--lock goes with --run-log (--id always locks)')
  console.log(apply ? '[revert-atest] --apply: writing' : '[revert-atest] DRY RUN — no writes. Use --apply.')
  const n = useRunLog ? await byRunLog() : await byId()
  console.log(`[revert-atest] ${apply ? 'changed' : 'would change'} ${n} rows`)
}

main().catch((err) => {
  console.error('[revert-atest] CRASH:', err.message)
  process.exit(1)
})
