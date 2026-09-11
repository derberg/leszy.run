// Read-only data-quality audit over scraper_all + calendar_events.
//
// WHY THIS EXISTS
// The pipeline's only health signal used to be "did the run finish" and "did
// any row change". Neither notices data that is present but WRONG, so nothing
// ever looked at the 15 rows carrying a fabricated price_from=0/price_to=500,
// or the 19 rows whose regulamin_url pointed at a consent form. They were
// enriched in April 2026 and were still live on calendar_events in September.
//
// This step answers the missing question — "does what we published look sane?"
// It writes nothing. Exit code 2 means findings, which the scheduler turns into
// a [WARN] email and then CONTINUES; exit 1 is a real failure.
//
// Usage: cd backend && node --env-file=../.env scripts/run-data-audit.js
//        --json   machine-readable output instead of the text report

import { createClient } from '@supabase/supabase-js'
import { NOT_REGULAMIN, IS_REGULAMIN } from '../src/lib/pickRegulaminUrl.js'

const asJson = process.argv.includes('--json')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Price sanity. A wide span is NOT the signal — measured over the 945 future
// scraper_all rows on 2026-09-11, "span > 200 zł" flags 36 rows and most are
// genuine (Łemkowyna Trail really is 240–689 zł across its distances). An alert
// that fires on 36 legitimate rows is an alert nobody reads.
//
// What IS diagnostic is a contradictory floor: free entry (0 zł) alongside a
// 200 zł+ ceiling cannot both be true, and it is the exact fingerprint of the
// fabricated "0–500 zł" the LLM produced from documents containing no fee.
// That rule flags 5 rows, plus 1 with an absurd ceiling — a signal, not noise.
const ZERO_FLOOR_CEILING = 200
const ABSURD_CEILING = 1000

// Reported for visibility only — never alerts. 432 future rows were last
// enriched over 90 days ago, which is a backlog size, not a defect: treating it
// as a warning would make the audit cry wolf on every single run.
const STALE_ENRICH_DAYS = 90

// PostgREST caps a response at 1000 rows regardless of what you ask for, so
// every scan here pages explicitly rather than trusting one .select().
async function selectAll(table, columns, applyFilters) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1)
    if (applyFilters) q = applyFilters(q)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

function isSuspectRegulamin(url) {
  if (!url) return false
  const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '')
  // Same precedence as the picker: a positive token in the document's own name
  // wins, so "Regulamin_..._RODO.pdf" is not flagged.
  if (IS_REGULAMIN.test(name)) return false
  return NOT_REGULAMIN.test(name)
}

async function main() {
  const today = new Date().toISOString().slice(0, 10)
  const staleBefore = new Date(Date.now() - STALE_ENRICH_DAYS * 864e5).toISOString()

  const scraperRows = await selectAll(
    'scraper_all',
    'id,name,date,source,source_id,regulamin_url,price_from,price_to,enriched_at',
    (q) => q.gte('date', today),
  )
  const calRows = await selectAll(
    'calendar_events',
    'id,name,date,status,regulamin_url,price_from,price_to,enriched_at',
    (q) => q.gte('date', today).eq('status', 'active'),
  )

  const findings = {
    suspect_regulamin: [],
    implausible_price: [],
    stale_enrichment: [],
  }

  for (const [table, rows] of [['scraper_all', scraperRows], ['calendar_events', calRows]]) {
    for (const r of rows) {
      const ref = { table, id: r.id, name: r.name, date: r.date }
      if (isSuspectRegulamin(r.regulamin_url)) {
        findings.suspect_regulamin.push({ ...ref, regulamin_url: r.regulamin_url })
      }
      if (r.price_from !== null && r.price_to !== null) {
        const contradictory = r.price_from === 0 && r.price_to >= ZERO_FLOOR_CEILING
        const absurd = r.price_to > ABSURD_CEILING
        const inverted = r.price_from > r.price_to
        if (contradictory || absurd || inverted) {
          findings.implausible_price.push({ ...ref, price_from: r.price_from, price_to: r.price_to })
        }
      }
      if (r.enriched_at && r.enriched_at < staleBefore) {
        findings.stale_enrichment.push({ ...ref, enriched_at: r.enriched_at })
      }
    }
  }

  // Only these two decide the exit code. stale_enrichment is informational.
  const alerting = findings.suspect_regulamin.length + findings.implausible_price.length

  if (asJson) {
    console.log(JSON.stringify({ scanned: scraperRows.length + calRows.length, alerting, findings }, null, 2))
  } else {
    console.log(`Data audit — ${scraperRows.length} scraper_all + ${calRows.length} calendar_events future rows\n`)
    const report = [
      ['regulamin_url names a non-regulamin document', findings.suspect_regulamin,
        (f) => `${f.regulamin_url}`],
      ['price range is self-contradictory', findings.implausible_price,
        (f) => `${f.price_from}–${f.price_to} zł`],
    ]
    for (const [title, list, fmt] of report) {
      console.log(`${list.length === 0 ? 'OK  ' : 'WARN'}  ${title}: ${list.length}`)
      for (const f of list.slice(0, 20)) {
        console.log(`        [${f.table}] ${f.date}  ${f.name}\n              ${fmt(f)}`)
      }
      if (list.length > 20) console.log(`        … and ${list.length - 20} more`)
    }
    console.log(`\nINFO  enriched over ${STALE_ENRICH_DAYS} days ago, event still upcoming: ` +
      `${findings.stale_enrichment.length} (not alerted — backlog size, not a defect)`)
    console.log(`\n${alerting} alerting finding(s).`)
  }

  process.exit(alerting > 0 ? 2 : 0)
}

main().catch((err) => {
  console.error(`data audit failed: ${err.message}`)
  process.exit(1)
})
