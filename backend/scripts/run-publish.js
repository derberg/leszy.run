import { publishToCalendar } from '../src/scrapers/index.js'
import { writeRunLog } from './lib/run-log.js'

// Usage: cd backend && node --env-file=../.env scripts/run-publish.js [--apply]
// Pushes scraper_all rows into calendar_events.
//   - new event (no matching CE row) → INSERT as 'pending'
//   - existing CE row, scraper_all has fresher data → UPDATE non-locked, fill-empty fields
//   - rejected CE row → never touched
//   - fuzzy match (same date + similar name) → skipped, surfaced for admin
// Dry run by default — use --apply to write to DB.

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
const dryRun = !process.argv.includes('--apply')
// Field-level "skip" details (already_populated, locked, terrain_conflict,
// etc.) are rarely actionable in normal review — they describe "the
// publisher dropped this incoming field on purpose". Hide all of them by
// default. Pass --show-skips for the full report.
const showSkips = process.argv.includes('--show-skips')

if (dryRun) {
  console.log(c.bold + c.yellow + '\n' + HR_HEAVY)
  console.log('  DRY RUN — no DB writes. Use --apply to commit.')
  console.log(HR_HEAVY + c.reset)
  console.log(c.dim + '  legend: ' + c.reset
    + c.green + '+' + c.reset + ' new pending CE row, '
    + c.yellow + '~' + c.reset + ' update existing CE')
  console.log(c.dim + '  hidden by default: per-field skip details (already_populated, locked, terrain_conflict, …). Pass --show-skips for the full report.' + c.reset)
  console.log()
} else {
  console.log(c.bold + c.red + '\n' + HR_HEAVY)
  console.log('  --APPLY MODE — writing to calendar_events.')
  console.log(HR_HEAVY + c.reset + '\n')
}

function locationToString(loc) {
  if (!loc) return ''
  if (typeof loc === 'string') return loc
  if (typeof loc === 'object') {
    return [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || JSON.stringify(loc)
  }
  return String(loc)
}

function fmtVal(v) {
  if (v === null || v === undefined) return '∅'
  if (Array.isArray(v)) return `[${v.join(', ')}]`
  if (typeof v === 'string' && v.length > 60) return `"${v.slice(0, 57)}…"`
  if (typeof v === 'string') return `"${v}"`
  return String(v)
}

publishToCalendar({ dryRun })
  .then(async ({ created, updated, unchanged, rejectedSkipped, fuzzySkipped, errors, createdLog, updatedLog, fuzzyLog }) => {
    // ─── Created ─────────────────────────────────────────────────
    if (createdLog && createdLog.length > 0) {
      console.log(c.bold + HR_HEAVY + c.reset)
      console.log(c.bold + `  ${dryRun ? 'Would create' : 'Created'} ${createdLog.length} new pending CE row(s)` + c.reset)
      console.log(c.gray + HR_LIGHT + c.reset)
      for (const ce of createdLog) {
        const place = [locationToString(ce.location), ce.voivodeship].filter(Boolean).join(' / ')
        console.log(
          `  ${c.green}+${c.reset} `
          + c.cyan + `[${ce.date}]` + c.reset
          + ' ' + c.bold + `"${ce.name}"` + c.reset
          + (place ? c.dim + ` — ${place}` + c.reset : '')
          + c.gray + `  (${ce.source}:${ce.source_id})` + c.reset
        )
      }
    }

    // ─── Updated ─────────────────────────────────────────────────
    if (updatedLog && updatedLog.length > 0) {
      const realUpdates = updatedLog.filter(u => !u.no_op)
      const noOpSkips = updatedLog.filter(u => u.no_op)

      // Aggregate skip stats so we can show a one-line summary even when
      // hiding details. Useful for spotting unusual spikes without scrolling.
      const skipReasonCounts = {}
      let totalSkipFields = 0
      for (const u of updatedLog) {
        for (const s of u.skipped || []) {
          totalSkipFields++
          skipReasonCounts[s.reason] = (skipReasonCounts[s.reason] || 0) + 1
        }
      }

      if (realUpdates.length > 0) {
        console.log()
        console.log(c.bold + HR_HEAVY + c.reset)
        console.log(c.bold + `  ${dryRun ? 'Would update' : 'Updated'} ${realUpdates.length} existing CE row(s)` + c.reset)
        console.log(c.gray + HR_LIGHT + c.reset)
        for (const u of realUpdates) {
          // Skip-detail mode: print row only if it has writes OR (when --show-skips) any skips
          const skipsToPrint = showSkips ? (u.skipped || []) : []
          if ((!u.fields || u.fields.length === 0) && skipsToPrint.length === 0) continue

          console.log(
            `  ${c.yellow}~${c.reset} `
            + c.cyan + `[${u.date}]` + c.reset
            + ' ' + c.bold + `"${u.name}"` + c.reset
            + c.gray + `  (ce.id=${u.ce_id})` + c.reset
          )
          if (u.fields && u.fields.length > 0) {
            console.log('      ' + c.green + 'writes:  ' + c.reset + u.fields.join(', '))
          }
          for (const s of skipsToPrint) {
            const reasonColor = s.reason === 'locked' ? c.red : c.yellow
            console.log(
              '      ' + c.red + '!skip:   ' + c.reset
              + c.bold + s.field + c.reset
              + c.gray + ' (' + c.reset + reasonColor + s.reason + c.reset + c.gray + ')' + c.reset
              + c.dim + `  ce=${fmtVal(s.ce_value)} sa=${fmtVal(s.sa_value)}` + c.reset
            )
          }
        }
      }

      // No-op skips section — only shown with --show-skips. Otherwise rolled
      // into the aggregate skip stats below.
      if (showSkips && noOpSkips.length > 0) {
        console.log()
        console.log(c.bold + HR_HEAVY + c.reset)
        console.log(c.bold + `  ${noOpSkips.length} CE row(s) with all-skipped fields (data not landing)` + c.reset)
        console.log(c.gray + HR_LIGHT + c.reset)
        for (const u of noOpSkips) {
          console.log(
            `  ${c.red}!${c.reset} `
            + c.cyan + `[${u.date}]` + c.reset
            + ' ' + c.bold + `"${u.name}"` + c.reset
            + c.gray + `  (ce.id=${u.ce_id})` + c.reset
          )
          for (const s of u.skipped || []) {
            const reasonColor = s.reason === 'locked' ? c.red : c.yellow
            console.log(
              '      ' + c.red + '!skip:   ' + c.reset
              + c.bold + s.field + c.reset
              + c.gray + ' (' + c.reset + reasonColor + s.reason + c.reset + c.gray + ')' + c.reset
              + c.dim + `  ce=${fmtVal(s.ce_value)} sa=${fmtVal(s.sa_value)}` + c.reset
            )
          }
        }
      }

      // One-line skip-stats summary (always shown when there are skips)
      if (!showSkips && totalSkipFields > 0) {
        const noOpCount = noOpSkips.length
        const breakdown = Object.entries(skipReasonCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `${reason}=${n}`)
          .join(', ')
        console.log()
        console.log(c.dim + `  ${totalSkipFields} field-level skips suppressed (${breakdown})` + c.reset)
        if (noOpCount > 0) {
          console.log(c.dim + `  ${noOpCount} CE row(s) had every field skipped (no data landed). Pass --show-skips for details.` + c.reset)
        }
      }
    }

    // ─── Fuzzy-skipped ───────────────────────────────────────────
    if (fuzzyLog && fuzzyLog.length > 0) {
      console.log()
      console.log(c.bold + HR_HEAVY + c.reset)
      console.log(c.bold + `  Fuzzy-skipped: ${fuzzyLog.length} scraper_all row(s) match an existing CE on date+name (would create duplicate)` + c.reset)
      console.log(c.gray + HR_LIGHT + c.reset)
      for (const f of fuzzyLog) {
        console.log(
          `  ${c.yellow}≈${c.reset} `
          + c.cyan + `[${f.date}]` + c.reset
          + ' ' + c.bold + `"${f.sa_name}"` + c.reset
          + c.gray + `  (${f.sa_source}:${f.sa_source_id})` + c.reset
        )
        console.log(
          '      ' + c.dim + 'matches CE: ' + c.reset
          + c.italic + `"${f.ce_name}"` + c.reset
          + c.gray + `  sa.loc=${fmtVal(f.sa_location)}  ce.loc=${fmtVal(f.ce_location)}` + c.reset
        )
        console.log('      ' + c.dim + 'reason=' + c.reset + c.yellow + f.reason + c.reset)
      }
    }

    // ─── Summary footer ──────────────────────────────────────────
    console.log()
    console.log(c.bold + HR_HEAVY + c.reset)
    console.log(
      c.bold + '  Publish Summary  ' + c.reset
      + c.dim + 'created=' + c.reset + c.green + created + c.reset
      + c.dim + '  updated=' + c.reset + c.yellow + updated + c.reset
      + c.dim + '  unchanged=' + c.reset + unchanged
      + c.dim + '  rejectedSkipped=' + c.reset + (rejectedSkipped ? c.gray : '') + rejectedSkipped + c.reset
      + c.dim + '  fuzzySkipped=' + c.reset + (fuzzySkipped ? c.yellow : '') + (fuzzySkipped || 0) + c.reset
      + c.dim + '  errors=' + c.reset + (errors.length ? c.red : c.gray) + errors.length + c.reset
    )
    console.log(c.bold + HR_HEAVY + c.reset)
    for (const e of errors) {
      console.log(c.red + `    ERR: ${e.name || ''} ${e.message}` + c.reset)
    }

    if (!dryRun) {
      const logFile = await writeRunLog('publish', {
        script: 'publish',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        created,
        updated,
        unchanged,
        rejected_skipped: rejectedSkipped,
        fuzzy_skipped: fuzzySkipped || 0,
        errors: errors.map(e => ({ name: e.name || null, message: String(e.message || e) })),
        created_events: (createdLog || []).map(ce => ({
          name: ce.name,
          date: ce.date,
          location: ce.location,
          voivodeship: ce.voivodeship,
          source: ce.source,
          source_id: ce.source_id,
        })),
        updated_events: (updatedLog || []).map(u => ({
          name: u.name,
          date: u.date,
          ce_id: u.ce_id,
          fields: u.fields || [],
          skipped: u.skipped || [],
          no_op: !!u.no_op,
        })),
        fuzzy_log: fuzzyLog || [],
      })
      console.log(c.dim + `\nRun log: ${logFile}` + c.reset)
    }
    process.exit(0)
  })
  .catch(async err => {
    console.error(c.red + c.bold + 'CRASH:' + c.reset, err)
    await writeRunLog('publish', {
      script: 'publish',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      crashed: true,
      error: { message: String(err.message || err), stack: err.stack || null },
    }).catch(() => {})
    process.exit(1)
  })
