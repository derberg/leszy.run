// Usage: cd backend && node --env-file=../.env scripts/verify-regulamin-urls.js [--apply] [--all] [--limit n] [--only <source>:<id>] [--report <file>]
//
// Check that every regulamin_url in scraper_all still points at a regulamin,
// and fix the ones that do not.
//
// WHY
// regulamin_url gets written in three ways and none of them read the document:
// a scraper copies the organizer's link, the Python enricher's web search wrote
// its hit straight to the row until the verification gate (#103, 2026-09-05),
// and the merge carries both along. Step 8.1 reads each document only once
// (enriched_regulamin_at), so a junk URL it never mined, or mined before the
// gate existed, stays forever. On 2026-11-08 that was a council home page
// (kluki.pl), a remote-desktop vendor (ultraviewer.net for Ultra Świr), a
// national park's visitor rules on two races, and a wall calendar PDF.
//
// WHAT IT DOES, per row
//   the document reads as a regulamin (looksLikeRegulamin, for this race's name)
//                                              → kept; a wrapper page that
//                                                links one is swapped for it
//   it cannot be read (dead link, scan, timeout) → kept and listed: not reading
//                                                a document is not knowing it
//                                                is wrong
//   it is not a regulamin                       → huntRegulamin() looks for the
//                                                real one near it; found, the
//                                                URL is replaced, otherwise it
//                                                is cleared
// A replaced or cleared row gets enriched_regulamin_at = NULL, so step 8.1
// mines the new document (or, cleared, is no longer counted as mined).
//
// Default is a dry run that writes nothing. --apply writes to scraper_all only;
// calendar_events is never touched here. Host-only: pdftotext and textutil.
//
// Options:
//   --apply          write the replacements and clears
//   --all            include past races (default: date >= today)
//   --limit <n>      stop after n rows, soonest race first
//   --only <s>:<id>  just these rows, repeatable
//   --report <file>  also write the outcome of every row as JSON

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, unlinkSync } from 'fs'
import { acquireRegulamin, fetchDoc } from './lib/regulaminDocument.js'
import { huntRegulamin } from './lib/regulaminHunt.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const all = argv.includes('--all')
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
const limit = valueOf('--limit') ? Number(valueOf('--limit')) : null
const reportFile = valueOf('--report')
const only = argv.flatMap((a, i) => (a === '--only' ? [argv[i + 1]] : []))
  .map((s) => { const k = s.indexOf(':'); return { source: s.slice(0, k), source_id: s.slice(k + 1) } })

const CONCURRENCY = 4

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function loadRows() {
  const rows = []
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from('scraper_all')
      .select('id, source, source_id, name, date, location, regulamin_url, registration_url, website')
      .not('regulamin_url', 'is', null)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
    if (!all && only.length === 0) q = q.gte('date', new Date().toISOString().slice(0, 10))
    if (only.length > 0) {
      // One .eq() pair per row, merged in JS: never interpolate into .or().
      const got = []
      for (const r of only) {
        const { data, error } = await supabase
          .from('scraper_all')
          .select('id, source, source_id, name, date, location, regulamin_url, registration_url, website')
          .eq('source', r.source).eq('source_id', r.source_id)
        if (error) throw error
        got.push(...data.filter((d) => d.regulamin_url))
      }
      return got
    }
    const { data, error } = await q.range(from, from + 999)
    if (error) throw error
    rows.push(...data)
    if (data.length < 1000) break
  }
  return limit ? rows.slice(0, limit) : rows
}

/** @returns {Promise<{action: 'keep'|'replace'|'clear', why: string, to?: string}>} */
async function judge(row) {
  const url = row.regulamin_url
  const doc = await acquireRegulamin(url, row)
  if (doc.path) { try { unlinkSync(doc.path) } catch {} }
  if (doc.error) return { action: 'keep', why: `unreadable: ${doc.error}` }

  const verdict = doc.identity?.verdict
  if (verdict === 'unknown') return { action: 'keep', why: `unknown: ${doc.identity.reason}` }
  if (verdict === 'regulamin') {
    if (doc.resolvedUrl && doc.resolvedUrl !== url) {
      return { action: 'replace', why: 'a wrapper page; the document it links reads as the regulamin', to: doc.resolvedUrl }
    }
    return { action: 'keep', why: `regulamin (${doc.identity.sections} sections)` }
  }

  const found = await huntRegulamin({ row, fetchDoc, skip: [url, doc.resolvedUrl].filter(Boolean) })
  if (found) {
    return {
      action: 'replace',
      why: `${doc.identity.reason}; found via ${found.via}${found.statesDate ? ', states the race date' : ''}`,
      to: found.url,
    }
  }
  return { action: 'clear', why: doc.identity.reason }
}

async function main() {
  const rows = await loadRows()
  console.log(`${rows.length} rows with a regulamin_url${all ? '' : ' (races from today on)'}${apply ? '' : ' — DRY RUN, nothing is written'}`)

  const results = new Array(rows.length)
  let next = 0
  let done = 0
  async function worker() {
    while (next < rows.length) {
      const i = next++
      const row = rows[i]
      let outcome
      try { outcome = await judge(row) } catch (err) { outcome = { action: 'keep', why: `error: ${err.message}` } }
      results[i] = { ...outcome, row }
      done++
      if (outcome.action !== 'keep') {
        console.log(`  [${done}/${rows.length}] ${outcome.action.toUpperCase()} ${row.name} (${row.date}, ${row.source}:${row.source_id})\n      ${row.regulamin_url}${outcome.to ? `\n    → ${outcome.to}` : ''}\n      ${outcome.why}`)
      } else if (done % 25 === 0) {
        console.log(`  [${done}/${rows.length}]`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const by = (a) => results.filter((r) => r.action === a)
  const unreadable = results.filter((r) => r.action === 'keep' && !/^regulamin/.test(r.why))
  console.log(`\nkeep ${by('keep').length} (of which ${unreadable.length} could not be judged), replace ${by('replace').length}, clear ${by('clear').length}`)

  if (reportFile) {
    writeFileSync(reportFile, JSON.stringify(results.map((r) => ({
      id: r.row.id, source: r.row.source, source_id: r.row.source_id, name: r.row.name, date: r.row.date,
      from: r.row.regulamin_url, action: r.action, to: r.to ?? null, why: r.why,
    })), null, 2))
    console.log(`report: ${reportFile}`)
  }

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.')
    return
  }
  let written = 0
  for (const r of [...by('replace'), ...by('clear')]) {
    const update = { regulamin_url: r.action === 'replace' ? r.to : null, enriched_regulamin_at: null }
    // Only if nobody changed the URL since we read it.
    const { error, count } = await supabase
      .from('scraper_all')
      .update(update, { count: 'exact' })
      .eq('id', r.row.id)
      .eq('regulamin_url', r.row.regulamin_url)
    if (error) console.log(`  ERR ${r.row.name}: ${error.message}`)
    else if (count === 0) console.log(`  SKIP ${r.row.name}: regulamin_url changed meanwhile`)
    else written++
  }
  console.log(`written: ${written}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
