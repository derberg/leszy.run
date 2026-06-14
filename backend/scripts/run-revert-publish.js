import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { supabase } from '../src/lib/supabaseClient.js'
import { logsDir, writeRunLog } from './lib/run-log.js'

// Usage:
//   cd backend && node --env-file=../.env scripts/run-revert-publish.js [--apply] [options]
//
// Reverts the CREATED (inserted) calendar_events rows from one or more publish
// runs. It reads the run logs written by run-publish.js (logs/publish-<ts>.json)
// and acts on each logged `created_events` entry, matched back to calendar_events
// by source + source_id.
//
// Which runs to revert:
//   (no flag)            → the single most recent publish-<ts>.json log
//   --log <file>         → that specific log (path or bare filename under logs/)
//   --since <YYYY-MM-DD> → every publish log on/after that UTC date
//   --since today        → every publish log from today (UTC)
//
// What "revert" does to each matched row:
//   (default)  --delete  → hard-DELETE the row. NOTE: scraper_all still holds the
//                          event, so the NEXT `run-publish.js --apply` will
//                          re-insert it. Use this for a clean re-run, not to kill junk.
//   --reject             → set status='rejected'. Permanent: publish skips rejected
//                          source:source_id keys, so it never comes back. Hidden from
//                          public kalendarz.
//
// Safety:
//   - Dry run by default. Pass --apply to write.
//   - Only rows still in status='pending' are touched. Rows an admin already
//     approved ('active') or rejected are reported and skipped — never deleted.
//   - Updated/unchanged events from the publish run are never touched; only inserts.

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = COLOR
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
      magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
    }
  : new Proxy({}, { get: () => '' })
const HR_HEAVY = '═'.repeat(80)
const HR_LIGHT = '─'.repeat(80)

const startedAt = new Date().toISOString()
const argv = process.argv.slice(2)
const dryRun = !argv.includes('--apply')
const mode = argv.includes('--reject') ? 'reject' : 'delete'

function argValue(flag) {
  const i = argv.indexOf(flag)
  if (i === -1) return null
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const logArg = argValue('--log')
const sinceArg = argValue('--since')

const PUBLISH_LOG_RE = /^publish-(\d{8})T\d{6}\.json$/  // excludes publish-event-pages-*

function die(msg) {
  console.error(c.red + c.bold + 'ERROR: ' + c.reset + msg)
  process.exit(1)
}

// ── Resolve which log file(s) to read ───────────────────────────────────────
async function resolveLogFiles() {
  const dir = logsDir()

  if (logArg) {
    // Explicit log: accept a full path or a bare filename under logs/
    const file = path.isAbsolute(logArg) || logArg.includes('/')
      ? logArg
      : path.join(dir, logArg)
    return [file]
  }

  let entries
  try {
    entries = await readdir(dir)
  } catch (err) {
    die(`Cannot read logs directory ${dir}: ${err.message}`)
  }
  const publishLogs = entries
    .map(name => ({ name, m: name.match(PUBLISH_LOG_RE) }))
    .filter(e => e.m)
    .sort((a, b) => a.name.localeCompare(b.name))  // chronological (ts in name)

  if (publishLogs.length === 0) die(`No publish-<ts>.json logs found in ${dir}`)

  if (sinceArg) {
    const since = sinceArg === 'today'
      ? new Date().toISOString().slice(0, 10).replace(/-/g, '')  // YYYYMMDD, UTC
      : sinceArg.replace(/-/g, '')
    if (!/^\d{8}$/.test(since)) die(`--since expects YYYY-MM-DD or "today", got "${sinceArg}"`)
    const picked = publishLogs.filter(e => e.m[1] >= since)
    if (picked.length === 0) die(`No publish logs on/after ${sinceArg}`)
    return picked.map(e => path.join(dir, e.name))
  }

  // Default: most recent publish log only
  return [path.join(dir, publishLogs[publishLogs.length - 1].name)]
}

// ── Load created_events from the chosen logs ─────────────────────────────────
async function loadCreated(files) {
  const created = []  // { source, source_id, name, date, _logFile }
  for (const file of files) {
    let summary
    try {
      summary = JSON.parse(await readFile(file, 'utf8'))
    } catch (err) {
      die(`Cannot read log ${file}: ${err.message}`)
    }
    const events = Array.isArray(summary.created_events) ? summary.created_events : []
    for (const e of events) {
      if (!e.source || !e.source_id) continue  // can't match without the key
      created.push({ source: e.source, source_id: e.source_id, name: e.name, date: e.date, _logFile: path.basename(file) })
    }
  }
  return created
}

const key = e => `${e.source}:${e.source_id}`

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// ── Look up the logged events in calendar_events by source_id, match on full key ──
async function fetchCurrent(created) {
  const wantKeys = new Set(created.map(key))
  const sourceIds = [...new Set(created.map(e => e.source_id))]
  const byKey = new Map()  // 'source:source_id' → ce row

  for (const ids of chunk(sourceIds, 100)) {
    let fromIdx = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('calendar_events')
        .select('id, name, date, status, source, source_id')
        .in('source_id', ids)
        .range(fromIdx, fromIdx + pageSize - 1)
      if (error) die(`calendar_events lookup failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const r of data) {
        const k = `${r.source}:${r.source_id}`
        if (wantKeys.has(k)) byKey.set(k, r)
      }
      if (data.length < pageSize) break
      fromIdx += pageSize
    }
  }
  return byKey
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!supabase) die('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)')

  const files = await resolveLogFiles()
  const created = await loadCreated(files)

  if (dryRun) {
    console.log(c.bold + c.yellow + '\n' + HR_HEAVY)
    console.log(`  DRY RUN — no DB writes. Mode: ${mode.toUpperCase()}. Use --apply to commit.`)
    console.log(HR_HEAVY + c.reset)
  } else {
    console.log(c.bold + c.red + '\n' + HR_HEAVY)
    console.log(`  --APPLY MODE — will ${mode === 'delete' ? 'DELETE' : "set status='rejected' on"} pending calendar_events rows.`)
    console.log(HR_HEAVY + c.reset)
  }

  console.log(c.dim + `  logs: ${files.map(f => path.basename(f)).join(', ')}` + c.reset)
  console.log(c.dim + `  ${created.length} created-event(s) recorded in those run(s)` + c.reset + '\n')

  if (created.length === 0) {
    console.log(c.green + '  Nothing to revert — no created_events in the selected log(s).' + c.reset)
    process.exit(0)
  }

  const byKey = await fetchCurrent(created)

  // Partition the logged creations against current DB state. De-dupe by key so a
  // source:source_id that appears in multiple logs is acted on once.
  const seen = new Set()
  const toAct = []      // still pending → delete/reject
  const skipped = []    // present but status != pending → admin touched it
  const gone = []       // no matching CE row → already removed
  for (const e of created) {
    const k = key(e)
    if (seen.has(k)) continue
    seen.add(k)
    const ce = byKey.get(k)
    if (!ce) { gone.push(e); continue }
    if (ce.status === 'pending') toAct.push({ ...e, ce_id: ce.id, status: ce.status })
    else skipped.push({ ...e, ce_id: ce.id, status: ce.status })
  }

  // ── Report ──
  if (toAct.length > 0) {
    console.log(c.bold + HR_HEAVY + c.reset)
    console.log(c.bold + `  ${dryRun ? 'Would ' + mode : (mode === 'delete' ? 'Deleting' : 'Rejecting')} ${toAct.length} pending row(s)` + c.reset)
    console.log(c.gray + HR_LIGHT + c.reset)
    for (const e of toAct) {
      console.log(
        `  ${mode === 'delete' ? c.red + '✗' : c.yellow + '⊘'}${c.reset} `
        + c.cyan + `[${e.date}]` + c.reset
        + ' ' + c.bold + `"${e.name}"` + c.reset
        + c.gray + `  (${e.source}:${e.source_id}, ce.id=${e.ce_id})` + c.reset
      )
    }
  }

  if (skipped.length > 0) {
    console.log()
    console.log(c.bold + HR_HEAVY + c.reset)
    console.log(c.bold + c.yellow + `  Skipped ${skipped.length} row(s) — no longer 'pending' (admin touched, left untouched)` + c.reset)
    console.log(c.gray + HR_LIGHT + c.reset)
    for (const e of skipped) {
      console.log(
        `  ${c.yellow}!${c.reset} `
        + c.cyan + `[${e.date}]` + c.reset
        + ' ' + c.bold + `"${e.name}"` + c.reset
        + c.gray + `  (${e.source}:${e.source_id}, status=` + c.reset + c.magenta + e.status + c.reset + c.gray + ')' + c.reset
      )
    }
  }

  if (gone.length > 0) {
    console.log()
    console.log(c.dim + `  ${gone.length} created row(s) already absent from calendar_events (nothing to do)` + c.reset)
  }

  // ── Footer / apply ──
  console.log()
  console.log(c.bold + HR_HEAVY + c.reset)
  console.log(
    c.bold + '  Revert Summary  ' + c.reset
    + c.dim + 'mode=' + c.reset + (mode === 'delete' ? c.red : c.yellow) + mode + c.reset
    + c.dim + `  ${dryRun ? 'would_act' : 'acted'}=` + c.reset + c.green + toAct.length + c.reset
    + c.dim + '  skipped=' + c.reset + c.yellow + skipped.length + c.reset
    + c.dim + '  already_gone=' + c.reset + gone.length
  )
  console.log(c.bold + HR_HEAVY + c.reset)

  let acted = 0
  const errors = []
  if (!dryRun && toAct.length > 0) {
    const ids = toAct.map(e => e.ce_id)
    for (const idBatch of chunk(ids, 100)) {
      if (mode === 'delete') {
        const { error } = await supabase.from('calendar_events').delete().in('id', idBatch)
        if (error) errors.push(`delete batch failed: ${error.message}`)
        else acted += idBatch.length
      } else {
        const { error } = await supabase.from('calendar_events').update({ status: 'rejected' }).in('id', idBatch)
        if (error) errors.push(`reject batch failed: ${error.message}`)
        else acted += idBatch.length
      }
    }
    for (const e of errors) console.log(c.red + '    ERR: ' + e + c.reset)
    console.log(c.dim + `\n  ${mode === 'delete' ? 'Deleted' : 'Rejected'} ${acted} row(s).` + c.reset)

    const logFile = await writeRunLog('revert-publish', {
      script: 'revert-publish',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      mode,
      source_logs: files.map(f => path.basename(f)),
      acted,
      skipped_count: skipped.length,
      already_gone: gone.length,
      errors,
      acted_events: toAct.map(e => ({ name: e.name, date: e.date, source: e.source, source_id: e.source_id, ce_id: e.ce_id })),
      skipped_events: skipped.map(e => ({ name: e.name, date: e.date, source: e.source, source_id: e.source_id, ce_id: e.ce_id, status: e.status })),
    })
    console.log(c.dim + `  Run log: ${logFile}` + c.reset)
  } else if (dryRun && toAct.length > 0) {
    console.log(c.dim + `\n  Re-run with --apply to ${mode} the ${toAct.length} row(s) above.` + c.reset)
    if (mode === 'delete') {
      console.log(c.dim + '  (delete is undone by the next run-publish.js --apply — add --reject to make it permanent.)' + c.reset)
    }
  }

  process.exit(errors.length ? 1 : 0)
}

main().catch(err => {
  console.error(c.red + c.bold + 'CRASH:' + c.reset, err)
  process.exit(1)
})
