// Which rows run-enrich-from-regulamin.js mines on this run.
//
// `enriched_regulamin_at IS NULL` already means "not mined yet", so a second
// gate on `merged_at` can only ever remove work that still needs doing. It
// removed a lot of it. The step needs the `claude` CLI, so it is not in the
// scheduler and nothing schedules it at all. It runs when a person runs it. A
// default of "merged today" therefore asks that person to run it on the same
// UTC day as every merge. Whatever they miss is abandoned, because no later run
// widens its own scope. On 2026-09-29 that had stranded 124 future rows from 17
// sources, the oldest merged on 2026-03-28.
//
// The date floor replaces it. Un-mined rows are mostly races that have already
// happened (1341 of 1465 on 2026-09-29), their fees and deadlines are of no use
// to anyone, and each one costs a model call. Gating on the event date drops
// them without dropping a single upcoming race.

const DATE = /^\d{4}-\d{2}-\d{2}$/

function readValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1] ?? ''
}

/**
 * Resolve the row-selection scope from the command line.
 *
 * @param {object} options
 * @param {string[]} options.argv Arguments after the script name.
 * @param {string} options.today Today as YYYY-MM-DD, the floor for event dates.
 * @returns {{mergedSince: string|null, minDate: string|null, limit: number|null, description: string}}
 *   `mergedSince` and `minDate` are inclusive floors on `merged_at` and on the
 *   event date, and null means no floor. `limit` caps the number of rows, and
 *   null means no cap.
 * @throws {Error} When `--merged-since` or `--limit` is given an unusable value.
 *   The caller is a command-line script, so a bad flag stops the run rather
 *   than silently selecting a different set of rows.
 */
export function resolveRegulaminScope({ argv = [], today }) {
  const all = argv.includes('--all')

  let mergedSince = null
  if (argv.includes('--merged-since')) {
    const value = readValue(argv, '--merged-since')
    if (!DATE.test(value)) {
      throw new Error(`--merged-since expects YYYY-MM-DD, got: ${value || '(nothing)'}`)
    }
    mergedSince = value
  }

  let limit = null
  if (argv.includes('--limit')) {
    const value = readValue(argv, '--limit')
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(`--limit expects a positive whole number, got: ${value || '(nothing)'}`)
    }
    limit = Number(value)
  }

  const minDate = all ? null : today

  const description = all
    ? 'every un-mined row with a regulamin URL, past races included'
    : mergedSince
      ? `un-mined rows for races from ${today} on, merged since ${mergedSince}`
      : `every un-mined row with a regulamin URL for a race from ${today} on`

  return { mergedSince, minDate, limit, description }
}
