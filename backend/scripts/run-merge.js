import { mergeIntoScraperAll } from '../src/scrapers/index.js'
import { writeRunLog } from './lib/run-log.js'

// Usage: cd backend && node --env-file=../.env scripts/run-merge.js [--apply]
// Merges all raw scraper_* tables into scraper_all with priority-based dedup.
// dostartu wins over all, maratonypolskie loses to all.
// Dry run by default — use --apply to write to DB.

// ANSI colors. No-op when output is piped/non-TTY or NO_COLOR is set, so
// log files stay clean and a CI run doesn't smear escape codes everywhere.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = COLOR
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
      magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
      bgYellow: '\x1b[43m', bgRed: '\x1b[41m',
    }
  : new Proxy({}, { get: () => '' })

const HR_HEAVY = '═'.repeat(80)
const HR_LIGHT = '─'.repeat(80)
const HR_DOT = c.gray + '·'.repeat(80) + c.reset

const startedAt = new Date().toISOString()
const dryRun = !process.argv.includes('--apply')

// ─── Header banner ─────────────────────────────────────────────────────
if (dryRun) {
  console.log(c.bold + c.yellow + '\n' + HR_HEAVY)
  console.log('  DRY RUN — no DB writes. Use --apply to commit.')
  console.log(HR_HEAVY + c.reset)
  console.log(c.dim + '  legend: ' + c.reset
    + c.green + '+' + c.reset + ' new row, '
    + c.yellow + '~' + c.reset + ' merged into existing, '
    + c.red + '!' + c.reset + ' overwrites existing fields, '
    + c.cyan + 'reg|rul|web|geo' + c.reset + ' = field flags')
  console.log()
} else {
  console.log(c.bold + c.red + '\n' + HR_HEAVY)
  console.log('  --APPLY MODE — writing to database.')
  console.log(HR_HEAVY + c.reset + '\n')
}

// Coverage % colorizer: green if 100%, yellow if partial, gray if 0
const covColor = (have, total) => {
  if (total === 0) return c.gray
  if (have === total) return c.green
  if (have === 0) return c.gray
  return c.yellow
}

mergeIntoScraperAll({ dryRun })
  .then(async results => {
    console.log(c.bold + '\n' + HR_HEAVY)
    console.log('  Phase 1 Summary — raw scraper_* → scraper_all')
    console.log(HR_HEAVY + c.reset)

    for (const s of results.sources) {
      // Skip empty sources entirely to keep output focused on what changed
      if (s.total === 0 && (!s.rows || s.rows.length === 0)) continue

      console.log()
      console.log(c.bold + c.cyan + `  ▼ ${s.source}` + c.reset)
      console.log(c.gray + '  ' + HR_LIGHT + c.reset)

      // ─── Stats line ────────────────────────────────────────────
      const errStr = s.errors.length ? c.red + ` errors=${s.errors.length}` + c.reset : ''
      const skippedStr = s.skipped
        ? c.gray + ` skipped=${s.skipped}` + c.reset
          + c.dim + ` (non_running=${s.skippedReasons?.non_running || 0}, past_date=${s.skippedReasons?.past_date || 0}, junk=${s.skippedReasons?.junk || 0})` + c.reset
        : ''
      console.log(
        '    '
        + c.dim + 'total=' + c.reset + s.total
        + c.dim + '  created=' + c.reset + c.green + s.created + c.reset
        + c.dim + '  merged_into_existing=' + c.reset + c.yellow + s.updated + c.reset
        + skippedStr + errStr
      )

      // ─── Data quality (dry-run only) ──────────────────────────
      if (dryRun && s.rows && s.rows.length > 0) {
        const cov = {
          name: 0, date: 0, location: 0, voivodeship: 0,
          distances: 0, event_types: 0, is_kids: 0,
          price: 0, registration_url: 0, regulamin_url: 0,
          website: 0, lat_lng: 0, registration_deadline: 0,
        }
        for (const r of s.rows) {
          if (r.name) cov.name++
          if (r.date) cov.date++
          if (r.location) cov.location++
          if (r.voivodeship) cov.voivodeship++
          if (r.distances) cov.distances++
          if (r.event_types || r.event_type) cov.event_types++
          if (r.is_kids) cov.is_kids++
          if (r.price_from != null || r.price_to != null) cov.price++
          if (r.has_registration_url) cov.registration_url++
          if (r.has_regulamin_url) cov.regulamin_url++
          if (r.has_website) cov.website++
          if (r.has_lat_lng) cov.lat_lng++
          if (r.registration_deadline) cov.registration_deadline++
        }
        const n = s.rows.length
        const fmt = (k, label = k) => {
          const have = cov[k]
          return c.dim + label + '=' + c.reset + covColor(have, n) + `${have}/${n}` + c.reset
        }
        console.log()
        console.log(c.bold + '    Data coverage' + c.reset + c.dim + ` — green=full, yellow=partial, gray=empty (out of ${n} rows after skip filter):` + c.reset)
        console.log('      ' + [fmt('name'), fmt('date'), fmt('location'), fmt('voivodeship')].join('  '))
        console.log('      ' + [fmt('distances'), fmt('event_types'), fmt('is_kids'), fmt('price')].join('  '))
        console.log('      ' + [fmt('registration_url', 'reg_url'), fmt('regulamin_url'), fmt('website'), fmt('lat_lng')].join('  '))
        console.log('      ' + [fmt('registration_deadline', 'reg_deadline')].join('  '))

        // Per-row table
        const MAX_ROWS = 50
        const rowsToShow = s.rows.slice(0, MAX_ROWS)
        console.log()
        console.log(c.bold + `    Rows` + c.reset + (s.rows.length > MAX_ROWS ? c.dim + ` (first ${MAX_ROWS} of ${s.rows.length})` + c.reset : '') + c.dim + ` — flags: reg=registration_url, rul=regulamin_url, web=website, geo=lat/lng:` + c.reset)
        for (const r of rowsToShow) {
          const tags = []
          if (r.is_kids) tags.push('kids')
          if (r.event_types && r.event_types.length) tags.push(...r.event_types)
          else if (r.event_type) tags.push(...(Array.isArray(r.event_type) ? r.event_type : [r.event_type]))
          const flag = (key, label) => key ? c.green + label + c.reset : c.gray + '·'.repeat(label.length) + c.reset
          const flags = [
            flag(r.has_registration_url, 'reg'),
            flag(r.has_regulamin_url, 'rul'),
            flag(r.has_website, 'web'),
            flag(r.has_lat_lng, 'geo'),
          ].join(c.gray + '|' + c.reset)
          const price = r.price_from != null || r.price_to != null
            ? ' ' + c.magenta + `${r.price_from ?? '?'}-${r.price_to ?? '?'}zł` + c.reset
            : ''
          const dist = r.distances ? ' ' + c.green + `[${r.distances}]` + c.reset : ''
          const tagStr = tags.length ? ' ' + c.yellow + `{${tags.join(',')}}` + c.reset : ''
          const loc = r.location || '?'
          const voiv = r.voivodeship ? c.dim + ` (${r.voivodeship})` + c.reset : ''
          console.log(
            '      '
            + c.cyan + r.date + c.reset
            + c.gray + ' │ ' + c.reset + loc + voiv
            + c.gray + ' │ ' + c.reset + c.bold + `"${r.name}"` + c.reset
            + dist + tagStr + price + ' ' + flags
            + c.gray + `  (${s.source}:${r.source_id})` + c.reset
          )
        }
      }

      // ─── Match decisions ──────────────────────────────────────
      if (s.createdNames.length > 0 || s.updatedNames.length > 0) {
        console.log()
        console.log(c.bold + '    Merge decisions:' + c.reset)
      }

      for (const cn of s.createdNames) {
        if (typeof cn === 'string') {
          console.log(`    ${c.green}+${c.reset} ${cn}`)
        } else {
          const loc = cn.location ? c.dim + ` @ ${cn.location}` + c.reset : ''
          console.log(
            `    ${c.green}+${c.reset} `
            + c.cyan + `[${cn.date}]` + c.reset
            + ' ' + c.bold + `"${cn.name}"` + c.reset
            + loc
            + c.gray + `  (${s.source}:${cn.source_id})` + c.reset
          )
        }
      }
      for (const u of s.updatedNames) {
        if (typeof u === 'string') {
          console.log(`    ${c.yellow}~${c.reset} ${u}`)
        } else {
          const winsTag = u.incoming_wins ? ' ' + c.red + '[primary→incoming]' + c.reset : ''
          const overwrites = (u.overwrite_fields || []).length ? ' ' + c.red + `!overwrites=[${u.overwrite_fields.join(',')}]` + c.reset : ''
          const fills = (u.fill_fields || []).length ? ' ' + c.green + `fills=[${u.fill_fields.join(',')}]` + c.reset : ''
          console.log(
            `    ${c.yellow}~${c.reset} `
            + c.cyan + `[${u.raw_date}]` + c.reset
            + ' ' + c.bold + `"${u.raw_name}"` + c.reset
            + c.gray + ` (${s.source}:${u.raw_source_id})` + c.reset
          )
          console.log(
            '        ' + c.dim + '→ matches' + c.reset + ' '
            + c.magenta + `${u.matched_source}:${u.matched_source_id}` + c.reset
            + ' ' + c.italic + `"${u.matched_name}"` + c.reset
            + c.gray + ` (id=${u.matched_id})` + c.reset
          )
          console.log(
            '        ' + c.dim + 'reason=' + c.reset + c.yellow + u.reason + c.reset
            + winsTag + overwrites + fills
          )
        }
      }
      for (const e of s.errors) {
        console.log(`    ${c.red}ERR:${c.reset} ${e.name || ''} ${e.message}`)
      }
    }

    // ─── Totals footer ────────────────────────────────────────────
    const totals = results.sources.reduce((acc, s) => {
      acc.total += s.total; acc.created += s.created; acc.updated += s.updated; acc.errors += s.errors.length
      return acc
    }, { total: 0, created: 0, updated: 0, errors: 0 })
    console.log()
    console.log(c.bold + HR_HEAVY + c.reset)
    console.log(
      c.bold + '  TOTAL  ' + c.reset
      + c.dim + 'total=' + c.reset + totals.total
      + c.dim + '  created=' + c.reset + c.green + totals.created + c.reset
      + c.dim + '  merged=' + c.reset + c.yellow + totals.updated + c.reset
      + c.dim + '  errors=' + c.reset + (totals.errors ? c.red : c.gray) + totals.errors + c.reset
    )
    console.log(c.bold + HR_HEAVY + c.reset)

    if (!dryRun) {
      const logFile = await writeRunLog('merge', {
        script: 'merge',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        sources: results.sources.map(s => ({
          source: s.source,
          total: s.total,
          created: s.created,
          deduped_within_run: s.updated,
          createdNames: s.createdNames,
          updatedNames: s.updatedNames,
          errors: s.errors.map(e => ({ name: e.name || null, message: String(e.message || e) })),
        })),
        totals,
      })
      console.log(c.dim + `\nRun log: ${logFile}` + c.reset)
    }
    process.exit(0)
  })
  .catch(async err => {
    console.error(c.red + c.bold + 'CRASH:' + c.reset, err)
    await writeRunLog('merge', {
      script: 'merge',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      crashed: true,
      error: { message: String(err.message || err), stack: err.stack || null },
    }).catch(() => {})
    process.exit(1)
  })
