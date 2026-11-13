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
import { DEADLINE_MAX_DAYS_BEFORE, deadlineDaysBefore } from '../src/lib/registrationDeadline.js'
import { NOT_REGULAMIN, IS_REGULAMIN } from '../src/lib/pickRegulaminUrl.js'
import { regulaminYear, isStaleRegulaminYear, confirmStaleInContent } from './lib/regulaminYear.js'
import { fetchDoc } from './lib/regulaminDocument.js'
import { statesDate } from './lib/regulaminHunt.js'

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

// A registration deadline this far ahead of the event, or after it, did not come
// from this edition's regulamin.
//
// This is the one extraction error the upstream gates cannot see: the document
// is the right regulamin and it DOES contain deadline language, so the evidence
// gate passes it — the model simply took the wrong date out of it. Only the
// shape of the result gives it away.
//
// Calibrated on the 731 future active calendar_events rows carrying a deadline
// (2026-09-11): median 5 days, 663 of them within 30 days, p95 at 88. A 30-day
// bar would therefore flag 133 rows, most of them legitimate — the same
// cry-wolf trap the price-span rule fell into. 120 days flags 34, plus 7 with a
// deadline after the race.
//
// Those 34 are overwhelmingly one recognisable failure: a ~365-day offset, i.e.
// the PREVIOUS edition's deadline (Bieg Renifera 2026-12-19 with a 2025-11-25
// deadline, Krakowski Bieg Sylwestowy 2026-12-31 with 2025-12-31). Worth an
// alert; a 45-day early-bird close is not.
//
// Since 2026-11-11 the same window is enforced where deadlines are written
// (src/lib/registrationDeadline.js, the merge, the AI enrichers, the publish,
// enricher/steps/merge.py), so this report finds only rows written earlier.
// The constant is imported from there so the audit and the writers never drift.

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

// A year in the document's filename that predates the event year means the
// organizer is linking last edition's rules. Sources do this to themselves —
// Blachowniańska Leśna Dycha replaced its 2026 regulamin link with the 2025
// file — and since a re-scrape is authoritative for its own record, we inherit
// it. Nothing can fix that automatically; surfacing it is the whole point.
// The rule is isStaleRegulaminYear() in ./lib/regulaminYear.js. A flagged
// document is then read (confirmStaleInContent): one that states the event's date
// is this year's text under last year's name, and is not reported.

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
    'id,name,date,source,source_id,regulamin_url,registration_deadline,price_from,price_to,enriched_at',
    (q) => q.gte('date', today),
  )
  const calRows = await selectAll(
    'calendar_events',
    'id,name,date,status,regulamin_url,registration_deadline,price_from,price_to,enriched_at',
    (q) => q.gte('date', today).eq('status', 'active'),
  )

  const findings = {
    suspect_regulamin: [],
    stale_regulamin_year: [],
    stale_regulamin_current_text: [],
    implausible_deadline: [],
    implausible_price: [],
    stale_enrichment: [],
  }

  for (const [table, rows] of [['scraper_all', scraperRows], ['calendar_events', calRows]]) {
    for (const r of rows) {
      const ref = { table, id: r.id, name: r.name, date: r.date }
      if (isSuspectRegulamin(r.regulamin_url)) {
        findings.suspect_regulamin.push({ ...ref, regulamin_url: r.regulamin_url })
      }
      if (isStaleRegulaminYear({ url: r.regulamin_url, eventDate: r.date, eventName: r.name })) {
        const docYear = regulaminYear(r.regulamin_url)
        findings.stale_regulamin_year.push({ ...ref, regulamin_url: r.regulamin_url, docYear })
      }
      if (r.registration_deadline && r.date) {
        const days = deadlineDaysBefore(r.registration_deadline, r.date)
        if (days !== null && (days > DEADLINE_MAX_DAYS_BEFORE || days < 0)) {
          findings.implausible_deadline.push({
            ...ref,
            registration_deadline: r.registration_deadline,
            days,
          })
        }
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

  // Read each flagged document once (calendar_events and scraper_all share URLs).
  const verdicts = new Map()
  const confirmed = []
  for (const f of findings.stale_regulamin_year) {
    const key = `${f.regulamin_url}|${f.date}`
    if (!verdicts.has(key)) {
      verdicts.set(key, confirmStaleInContent({ url: f.regulamin_url, eventDate: f.date }, { fetchDoc, statesDate }))
    }
    const v = await verdicts.get(key)
    if (v.stale) confirmed.push(v.unread ? { ...f, unread: v.unread } : f)
    else findings.stale_regulamin_current_text.push(f)
  }
  findings.stale_regulamin_year = confirmed

  // stale_enrichment is informational; everything else decides the exit code.
  const alerting =
    findings.suspect_regulamin.length +
    findings.stale_regulamin_year.length +
    findings.implausible_deadline.length +
    findings.implausible_price.length

  if (asJson) {
    console.log(JSON.stringify({ scanned: scraperRows.length + calRows.length, alerting, findings }, null, 2))
  } else {
    console.log(`Data audit — ${scraperRows.length} scraper_all + ${calRows.length} calendar_events future rows\n`)
    const report = [
      ['regulamin_url names a non-regulamin document', findings.suspect_regulamin,
        (f) => `${f.regulamin_url}`],
      ['regulamin filename is from an earlier year than the event', findings.stale_regulamin_year,
        (f) => `doc year ${f.docYear}${f.unread ? ` (not read: ${f.unread})` : ''} · ${f.regulamin_url}`],
      [`registration deadline more than ${DEADLINE_MAX_DAYS_BEFORE} days before the event, or after it`,
        findings.implausible_deadline,
        (f) => `${f.registration_deadline} (${f.days} days before)`],
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
    console.log(`\nINFO  old year in the filename, but the document states the event date: ` +
      `${findings.stale_regulamin_current_text.length} (not alerted)`)
    console.log(`INFO  enriched over ${STALE_ENRICH_DAYS} days ago, event still upcoming: ` +
      `${findings.stale_enrichment.length} (not alerted — backlog size, not a defect)`)
    console.log(`\n${alerting} alerting finding(s).`)
  }

  process.exit(alerting > 0 ? 2 : 0)
}

main().catch((err) => {
  console.error(`data audit failed: ${err.message}`)
  process.exit(1)
})
