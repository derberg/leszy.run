// Find the events that would publish incomplete, work out which code is
// responsible, fix it, and re-scrape so the data comes back right.
//
// WHY THIS EXISTS
// On 2026-09-11 an operator published a batch of scraped events, opened the
// admin calendar, and picked out nine rows that were not ready to accept. Each
// one became a separate session asking the same question, and each ended in a
// merged pull request: #104 to #118. The questions differed. The method did
// not, and the defects were never about one event. zapisyonline rejected a
// .docx regulamin, so 45 rows lost their rules document. zmierzymyczas took the
// last PDF on the page, so 19 rows carried a consent form instead. One event
// showed each defect. The fix repaired hundreds of rows.
//
// So the review was not review. It was defect discovery with a sample of nine,
// run by hand, repeated after every publish. This step runs it.
//
// It runs BEFORE run-publish --apply. Nothing has reached calendar_events yet,
// so a defect is corrected in code and the data is rebuilt by re-running the
// scrape. No row on the public table is ever patched by hand.
//
// Usage: cd backend && node --env-file=../.env scripts/run-prepublish-review.js
//   (default)           diagnose and report. Opens no pull request.
//   --apply             allow fix agents, pull requests and merges
//   --limit N           events to investigate (default 40)
//   --max-merges N      merges allowed in one run (default 5)
//   --concurrency N     diagnose agents at once (default 6)
//   --fix-concurrency N fix agents at once (default 3)
//   --no-heal           skip the re-scrape after merging
//   --json              machine-readable report on stdout
//
// Exit 0 clean, 2 findings reported, 1 the step itself failed.

import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { publishToCalendar } from '../src/scrapers/index.js'
import {
  runAgent,
  sanitizedEnv,
  groupFindings,
  partitionCandidates,
  mergeCommands,
  branchSlug,
  planFixAttempt,
  checkDiffPaths,
  countBlastRadius,
  mapWithConcurrency,
  normalizeDiagnosis,
  settledVerdicts,
  unsettledFields,
  pickPrNumber,
  shouldKeepWorktree,
  needsRevision,
  planHeal,
} from './lib/reviewAgents.js'
import { diagnosePrompt, fixPrompt, reviewPrompt, revisePrompt } from './lib/reviewPrompts.js'

const argv = process.argv
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}
const apply = argv.includes('--apply')
const asJson = argv.includes('--json')
const heal = !argv.includes('--no-heal')
const LIMIT = flag('--limit', 40)
const MAX_MERGES = flag('--max-merges', 5)
const CONCURRENCY = flag('--concurrency', 6)
const FIX_CONCURRENCY = flag('--fix-concurrency', 3)

const DIAGNOSE_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'Bash(curl:*)', 'Bash(pdftotext:*)', 'Bash(textutil:*)', 'Bash(python3:*)']
const FIX_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'Bash']
const REVIEW_TOOLS = ['Read', 'Grep', 'Glob']

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
const MAIN_ROOT = (() => {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf-8', cwd: REPO_ROOT }).trim()
  const abs = path.isAbsolute(common) ? common : path.join(REPO_ROOT, common)
  return path.resolve(abs, '..')
})()

const log = (...a) => { if (!asJson) console.log(...a) }
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, ...opts })

// What earlier runs already proved. A field an agent has recently shown to be
// unpublished is not bought a second time.
async function loadSettled() {
  const { data, error } = await supabase
    .from('prepublish_verdicts')
    .select('source, source_id, field, verdict, decided_at')
  if (error) {
    log(`      ! could not read prepublish_verdicts (${error.message}); every field will be diagnosed again`)
    return new Set()
  }
  return settledVerdicts(data || [])
}

// Phase 0. Which events would publish incomplete, and which of their fields are
// still open questions.
async function selectCandidates() {
  log('[0/5] Asking run-publish what it would write...')
  const result = await publishToCalendar({ dryRun: true })
  const rows = [
    ...(result.createdLog || []).map((r) => ({ ...r, kind: 'create' })),
    ...(result.updatedLog || []).filter((r) => !r.no_op).map((r) => ({ ...r, kind: 'update' })),
  ]
  const notReady = rows
    .filter((r) => r.ready === false)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  log(`      ${rows.length} row(s) would be written, ${notReady.length} not ready to accept`)

  const settled = await loadSettled()
  const open = []
  let answered = 0
  for (const row of notReady) {
    const fields = unsettledFields(row, settled)
    if (fields.length === 0) {
      answered++
      continue
    }
    // The agent is asked only about the fields still open, so a race whose
    // regulamin was settled last week is not re-investigated for it.
    open.push({ ...row, missing_required: fields, missing_all: row.missing_required })
  }
  if (answered > 0) log(`      ${answered} of them were already answered by an earlier run, so they are not diagnosed again`)
  return { candidates: open.slice(0, LIMIT), notReady: notReady.length, answered }
}

// Every row a diagnose agent needs, fetched here so the agent can run without
// database credentials of any kind.
async function contextFor(candidate) {
  const { source, source_id } = candidate
  const one = async (table, narrow) => {
    try {
      const { data, error } = await narrow(supabase.from(table).select('*')).maybeSingle()
      return error ? null : data
    } catch {
      return null
    }
  }
  const [scraperAllRow, rawRow, existingRow] = await Promise.all([
    one('scraper_all', (q) => q.eq('source', source).eq('source_id', source_id)),
    one(`scraper_${source}`, (q) => q.eq('source_id', source_id)),
    one('calendar_events', (q) => q.eq('source', source).eq('source_id', source_id)),
  ])
  return { scraperAllRow, rawRow, existingRow }
}

// Phase 1. One agent per event, read-only.
async function diagnose(candidates) {
  log(`\n[1/5] Diagnosing ${candidates.length} event(s), ${CONCURRENCY} at a time...`)
  const env = sanitizedEnv()
  const results = await mapWithConcurrency(candidates, CONCURRENCY, async (candidate) => {
    const ctx = await contextFor(candidate)
    const prompt = diagnosePrompt({
      candidate,
      ...ctx,
      sourceFile: `backend/src/scrapers/sources/${candidate.source}.js`,
    })
    const res = await runAgent({ prompt, cwd: REPO_ROOT, allowedTools: DIAGNOSE_TOOLS, model: 'sonnet', env })
    if (!res.ok) log(`      ? ${candidate.name}: ${res.error || 'no JSON returned'}`)

    // One finding per missing field. An answer that covers three fields out of
    // four leaves the fourth as needs-human rather than as nothing, so a field
    // the agent quietly skipped is still visible in the report.
    const findings = normalizeDiagnosis(res.json, candidate)
    findings.forEach((f, i) => { f.costUsd = i === 0 ? res.costUsd : 0 })
    for (const f of findings) {
      const mark = { 'code-defect': 'X', 'absent-at-source': '-', 'needs-human': '?' }[f.verdict] || '?'
      log(`      ${mark} ${candidate.name} [${f.field}]: ${f.summary || f.verdict}`)
    }
    return findings
  })
  return results.filter(Boolean).flat()
}

// Phase 1b. Write down what was proved, so the next run does not buy it again
// and the admin calendar can say why a column is blank.
async function recordVerdicts(findings, runId) {
  const rows = findings
    .filter((f) => f.verdict === 'absent-at-source' || f.verdict === 'needs-human')
    .map((f) => ({
      source: f.event.source,
      source_id: String(f.event.source_id),
      field: f.field,
      verdict: f.verdict,
      summary: f.summary || null,
      evidence: f.evidence || null,
      event_name: f.event.name || null,
      event_date: f.event.date || null,
      decided_at: new Date().toISOString(),
      run_id: runId,
    }))
  if (rows.length === 0) return 0
  if (!apply) {
    log(`      ${rows.length} verdict(s) would be recorded. Pass --apply to write them.`)
    return 0
  }
  const { error } = await supabase
    .from('prepublish_verdicts')
    .upsert(rows, { onConflict: 'source,source_id,field' })
  if (error) {
    log(`      ! could not record verdicts: ${error.message}`)
    return 0
  }
  log(`      recorded ${rows.length} verdict(s) for the admin calendar`)
  return rows.length
}

// Phase 2. Collapse findings into distinct defects.
async function reconcile(findings) {
  const groups = groupFindings(findings)
  log(`\n[2/5] ${findings.length} finding(s) collapse into ${groups.length} defect(s)`)
  // groupFindings refuses a defect whose file is not a real file a fix agent may
  // touch. Say so, or the finding disappears between two counts.
  const grouped = groups.reduce((n, g) => n + g.findings.length, 0)
  const claimed = findings.filter((f) => f.verdict === 'code-defect').length
  if (claimed > grouped) {
    log(`      ! ${claimed - grouped} code-defect finding(s) named a file no fix agent may touch, or a file that does not exist — dropped`)
  }
  for (const group of groups) {
    const first = group.findings.find((f) => f.blast_radius)
    const measured = first ? await countBlastRadius(supabase, first.blast_radius) : { count: null }
    group.blastRadius = measured.count
    // Kept because a merged enricher fix is propagated to exactly the rows this
    // radius names. Without it the fix lands in the code and reaches no data.
    group.radius = measured.count == null ? null : first.blast_radius
    log(`      ${group.file} (${group.layer}): ${group.findings.length} event(s)`
      + (measured.count != null ? `, ${measured.count} row(s) share it` : ''))
  }
  return groups
}

// What GitHub says exists on this branch. The orchestrator used to take the
// pull request number from the fix agent's own JSON and skip the review whenever
// the agent reported anything other than "fixed". #161 was pushed and opened by
// an agent that then reported failure, so it appears in no report and no one has
// looked at it since.
function prsForBranch(branch) {
  try {
    const out = sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state'])
    return JSON.parse(out)
  } catch {
    return []
  }
}

// Phase 3. One agent per defect, each in its own worktree.
async function fixAll(groups) {
  log(`\n[3/5] Fixing ${groups.length} defect(s), ${FIX_CONCURRENCY} at a time...`)
  return mapWithConcurrency(groups, FIX_CONCURRENCY, async (group) => {
    const branch = `fix/auto-${branchSlug(group.key)}`.slice(0, 80)
    const worktree = path.join(MAIN_ROOT, '.worktrees', branch.replace(/\//g, '-'))

    // The branch name comes from the defect, so the same defect asks for the same
    // branch every run. A previous run may have left one behind.
    const plan = planFixAttempt({ branch, prs: prsForBranch(branch), worktreeExists: existsSync(worktree) })
    if (plan.action === 'skip-open-pr') {
      log(`      = ${group.file}: ${plan.reason}`)
      return { group, branch, status: 'already-open', pr: plan.pr }
    }
    if (plan.action === 'reset') {
      log(`      ${group.file}: clearing ${branch}, ${plan.reason}`)
      try { sh('bash', ['scripts/worktree.sh', 'rm', branch], { cwd: MAIN_ROOT }) } catch {}
      try { sh('git', ['branch', '-D', branch], { cwd: MAIN_ROOT }) } catch {}
    }

    try {
      sh('bash', ['scripts/worktree.sh', 'new', branch], { cwd: MAIN_ROOT })
    } catch (err) {
      log(`      ! ${group.file}: could not create a worktree: ${err.message.slice(0, 160)}`)
      return { group, status: 'failed', error: 'worktree' }
    }

    const res = await runAgent({
      prompt: fixPrompt({ group, blastRadius: group.blastRadius, branch }),
      cwd: worktree,
      allowedTools: FIX_TOOLS,
      model: 'opus',
      timeoutMs: 30 * 60 * 1000,
    })

    const outcome = res.json || {}
    if (!res.ok || outcome.status !== 'fixed') {
      log(`      - ${group.file}: ${outcome.status || 'no change'}`
        + (outcome.reason_if_no_change ? ` (${outcome.reason_if_no_change})` : ''))
      return { group, branch, worktree, status: outcome.status || 'failed', agent: outcome, error: res.error }
    }
    return { group, branch, worktree, status: 'fixed', agent: outcome }
  })
}

// The checks the orchestrator makes itself, because an agent reporting on its
// own work is not evidence. The tests run here and the diff is read here.
function verifyFix(fix) {
  const problems = []
  let changedFiles = []
  try {
    changedFiles = sh('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: fix.worktree })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (err) {
    problems.push(`could not read the diff: ${err.message.slice(0, 120)}`)
  }
  if (changedFiles.length === 0) problems.push('the branch changed nothing')

  const paths = checkDiffPaths(changedFiles)
  if (!paths.ok) problems.push(`touches files it may not change: ${paths.violations.join(', ')}`)
  if (!changedFiles.some((f) => f.startsWith('backend/test/'))) problems.push('no test was added')

  if (paths.ok && changedFiles.length > 0) {
    try {
      sh('npm', ['test', '--workspace=backend'], { cwd: fix.worktree, stdio: 'pipe' })
    } catch (err) {
      problems.push(`tests fail: ${String(err.stdout || err.message).slice(-400)}`)
    }
  }
  return { ok: problems.length === 0, problems, changedFiles }
}

// Phase 4. An independent agent reads the diff, then the merge.
//
// A reviewer asking for changes is not the end. The fix agent gets the concerns
// handed back once, in the worktree it already has, and the diff is reviewed
// again. Only then is the outcome recorded.
async function reviewAndMerge(fixes) {
  log(`\n[4/5] Reviewing ${fixes.length} branch(es)...`)
  let merged = 0
  const outcomes = []

  for (const fix of fixes) {
    const pr = pickPrNumber(fix.agent, prsForBranch(fix.branch))
    const record = { file: fix.group.file, branch: fix.branch, pr }

    if (!pr) {
      const why = fix.status === 'fixed' ? 'the agent reported a fix but opened no pull request' : (fix.agent?.reason_if_no_change || fix.status || 'no pull request')
      log(`      - ${fix.group.file}: ${why}`)
      outcomes.push({ ...record, outcome: 'no-pull-request', problems: [why] })
      continue
    }

    let revisions = 0
    let done = false
    while (!done) {
      const check = verifyFix(fix)
      if (!check.ok) {
        log(`      REJECTED ${fix.group.file}: ${check.problems[0]}`)
        outcomes.push({ ...record, outcome: 'rejected-by-rails', problems: check.problems })
        break
      }

      let diff = ''
      try {
        diff = sh('git', ['diff', 'origin/main...HEAD'], { cwd: fix.worktree }).slice(0, 60000)
      } catch {
        outcomes.push({ ...record, outcome: 'rejected-by-rails', problems: ['no diff'] })
        break
      }

      const res = await runAgent({
        prompt: reviewPrompt({ group: fix.group, diff, prNumber: pr }),
        cwd: fix.worktree,
        allowedTools: REVIEW_TOOLS,
        model: 'opus',
      })
      const verdict = res.json || { verdict: 'request-changes', reasoning: res.error || 'the reviewer returned nothing' }
      record.review = verdict

      if (verdict.verdict === 'approve') {
        if (merged >= MAX_MERGES) {
          log(`      HELD #${pr} ${fix.group.file}: the merge cap of ${MAX_MERGES} is reached`)
          outcomes.push({ ...record, outcome: 'held-at-merge-cap' })
          break
        }
        try {
          const [ghArgs, gitArgs] = mergeCommands(pr, fix.branch)
          sh('gh', ghArgs, { cwd: fix.worktree })
          merged++
          // The branch is gone from the remote, but the merge already counted, so
          // a failure to tidy up is not a failure to merge.
          try { sh('git', gitArgs, { cwd: fix.worktree }) } catch {}
          log(`      MERGED #${pr} ${fix.group.file}`)
          outcomes.push({ ...record, outcome: 'merged', radius: fix.group.radius, blastRadius: fix.group.blastRadius })
        } catch (err) {
          outcomes.push({ ...record, outcome: 'merge-failed', problems: [err.message.slice(0, 200)] })
        }
        break
      }

      if (needsRevision(verdict, revisions)) {
        revisions++
        log(`      REVISING #${pr} ${fix.group.file}: ${verdict.reasoning}`)
        const rev = await runAgent({
          prompt: revisePrompt({ group: fix.group, review: verdict, branch: fix.branch, prNumber: pr }),
          cwd: fix.worktree,
          allowedTools: FIX_TOOLS,
          model: 'opus',
          timeoutMs: 30 * 60 * 1000,
        })
        record.revision = rev.json || { status: 'failed', summary: rev.error || 'the revising agent returned nothing' }
        if (record.revision.status === 'failed') {
          log(`      ${String(verdict.verdict).toUpperCase()} #${pr} ${fix.group.file}: the revision failed`)
          outcomes.push({ ...record, outcome: verdict.verdict, revisions })
          break
        }
        continue
      }

      log(`      ${String(verdict.verdict).toUpperCase()} #${pr} ${fix.group.file}: ${verdict.reasoning}`)
      outcomes.push({ ...record, outcome: verdict.verdict, revisions })
      done = true
    }
  }

  // A worktree whose pull request is still open is the only checkout where that
  // change can be revised by hand, so it stays. Deleting it is what orphaned
  // #163 and #164.
  const kept = []
  for (const fix of fixes) {
    const record = outcomes.find((o) => o.branch === fix.branch)
    if (shouldKeepWorktree(record)) {
      kept.push({ pr: record.pr, branch: fix.branch, worktree: fix.worktree, file: fix.group.file })
      continue
    }
    try { sh('bash', ['scripts/worktree.sh', 'rm', fix.branch], { cwd: MAIN_ROOT }) } catch {}
  }
  for (const k of kept) {
    log(`      kept ${k.branch} for PR #${k.pr}, which is still open`)
  }
  return { outcomes, merged, kept }
}

// Phase 5. Make the merged fixes reach the data.
//
// This used to recognise backend/src/scrapers/sources/<name>.js and nothing
// else. On 2026-09-18 the one merged pull request fixed the enricher's regulamin
// search and had been measured against 60 rows, and this step logged "No source
// scraper changed, so there is nothing to re-scrape". All 60 rows kept the value
// the broken code had written.
//
// Each kind of fix needs a different push:
//   a scraper     re-scrape that source with --force, then merge again, because
//                 run-merge only reads raw rows where merged_at IS NULL
//   the enricher  clear the enrichment stamps on the rows the defect was
//                 measured against, because the enricher only ever reads rows it
//                 has not enriched yet and so never revisits its own mistakes
//   shared code   the nightly pipeline re-scrapes every source at 08:00 anyway
async function runHeal(mergedOutcomes) {
  const plan = planHeal(
    mergedOutcomes
      .filter((o) => o.outcome === 'merged')
      .map((o) => ({ file: o.file, radius: o.radius, blastRadius: o.blastRadius }))
  )
  const today = new Date().toISOString().slice(0, 10)
  const backend = path.join(MAIN_ROOT, 'backend')
  const done = { rescraped: [], reenriched: [], nightly: plan.nightly, unhealed: plan.unhealed }

  if (plan.rescrape.length === 0 && plan.reenrich.length === 0) {
    log('\n[5/5] Nothing merged needs a re-scrape or a re-enrichment.')
    for (const n of plan.nightly) log(`      ${n.file}: ${n.reason}`)
    for (const u of plan.unhealed) log(`      ! ${u.file}: ${u.reason}`)
    return done
  }

  log('\n[5/5] Propagating the merged fixes into the rows...')
  sh('git', ['pull', '--ff-only'], { cwd: MAIN_ROOT })

  if (plan.rescrape.length > 0) {
    const list = plan.rescrape.join(',')
    log(`      re-scraping ${list}`)
    sh('node', ['--env-file=../.env', 'scripts/run-scrapers.js', '--only', list, '--force', list], { cwd: backend, stdio: 'inherit' })
    for (const source of plan.rescrape) {
      const { error } = await supabase.from(`scraper_${source}`).update({ merged_at: null }).gte('date', today)
      if (error) log(`      ! could not clear merged_at on scraper_${source}: ${error.message}`)
      else done.rescraped.push(source)
    }
    sh('node', ['--env-file=../.env', 'scripts/run-merge.js', '--apply'], { cwd: backend, stdio: 'inherit' })
    sh('node', ['--env-file=../.env', 'scripts/run-normalize.js', '--apply'], { cwd: backend, stdio: 'inherit' })
  }

  for (const job of plan.reenrich) {
    let query = supabase.from(job.radius.table).update(Object.fromEntries(job.columns.map((c) => [c, null])))
    for (const f of job.radius.filters) query = query[f.op](f.column, f.value)
    if (job.radius.future_only) query = query.gte('date', today)
    const { error, count } = await query.select('*', { count: 'exact', head: true })
    if (error) {
      log(`      ! could not clear the enrichment stamps for ${job.file}: ${error.message}`)
      done.unhealed.push({ file: job.file, reason: error.message })
      continue
    }
    log(`      cleared the enrichment stamps on ${count ?? '?'} row(s) for ${job.file}; the next enricher run re-reads them`)
    done.reenriched.push({ file: job.file, rows: count ?? null })
  }

  for (const n of plan.nightly) log(`      ${n.file}: ${n.reason}`)
  for (const u of plan.unhealed) log(`      ! ${u.file}: ${u.reason}`)
  return done
}

async function main() {
  const startedAt = new Date().toISOString()
  const { candidates: selected, notReady, answered } = await selectCandidates()
  if (selected.length === 0) {
    // Three different reasons land here and they are not the same news. Saying
    // "everything is ready" when seven rows are incomplete and merely settled is
    // how a step stops being believed.
    if (notReady === 0) log('\nEvery row that would publish is ready to accept. There is nothing to review.')
    else if (answered === notReady) log(`\nAll ${notReady} incomplete row(s) were already answered by an earlier run. Nothing new to diagnose.`)
    else log(`\n${notReady} row(s) are incomplete but none were selected. Check --limit.`)
    return { exitCode: 0, report: { startedAt, notReady, answered, candidates: [], findings: [], defects: [] } }
  }

  // A row that does not say where it came from cannot be traced through the four
  // layers, so it is reported rather than handed to an agent that would guess.
  const { diagnosable: candidates, undiagnosable } = partitionCandidates(selected)
  for (const u of undiagnosable) {
    log(`      ! ${u.candidate?.name}: skipped, ${u.reason}`)
  }
  if (candidates.length === 0) {
    log('\nNo candidate carries a source, so there is nothing an agent can trace.')
    return { exitCode: 0, report: { startedAt, candidates: [], findings: [], defects: [], undiagnosable } }
  }

  const findings = await diagnose(candidates)
  const recorded = await recordVerdicts(findings, startedAt)
  const groups = await reconcile(findings)

  // A field nobody published and a field nobody could reach are both answers the
  // operator needs, and neither produces a pull request. They used to end up
  // only in this file. They are now on the row in the admin calendar as well.
  const absent = findings.filter((f) => f.verdict === 'absent-at-source')
  const human = findings.filter((f) => f.verdict === 'needs-human')
  if (absent.length > 0) {
    log(`\n      ${absent.length} field(s) are genuinely unpublished at source:`)
    for (const f of absent) log(`        ${f.event.name} [${f.field}]: ${f.summary}`)
  }
  if (human.length > 0) {
    log(`\n      ${human.length} field(s) need a person:`)
    for (const f of human) log(`        ${f.event.name} [${f.field}]: ${f.summary}`)
  }

  const report = {
    startedAt,
    apply,
    candidates: candidates.map((c) => ({ name: c.name, date: c.date, source: c.source, missing: c.missing_required })),
    undiagnosable: undiagnosable.map((u) => ({ name: u.candidate?.name, date: u.candidate?.date, reason: u.reason })),
    findings,
    absentAtSource: absent.map((f) => ({ event: f.event.name, field: f.field, summary: f.summary })),
    needsHuman: human.map((f) => ({ event: f.event.name, field: f.field, summary: f.summary })),
    verdictsRecorded: recorded,
    defects: groups.map((g) => ({ file: g.file, layer: g.layer, events: g.events.length, blastRadius: g.blastRadius, signatures: g.signatures })),
    costUsd: findings.reduce((sum, f) => sum + (f.costUsd || 0), 0),
  }

  if (!apply) {
    log('\nDry run. No pull request was opened. Pass --apply to let the fix agents work.')
    return { exitCode: groups.length > 0 ? 2 : 0, report }
  }

  // Every branch that got a worktree goes to review. Whether a pull request
  // exists is GitHub's answer, not the fix agent's.
  const attempts = await fixAll(groups)
  const fixes = attempts.filter((f) => f.worktree)
  const alreadyOpen = attempts
    .filter((f) => f.status === 'already-open')
    .map((f) => ({ pr: f.pr, branch: f.branch, file: f.group.file }))
  const { outcomes, merged, kept } = await reviewAndMerge(fixes)
  report.pullRequests = outcomes
  report.merged = merged
  report.openPullRequests = [...alreadyOpen, ...kept]
  report.heal = heal && merged > 0 ? await runHeal(outcomes) : { rescraped: [], reenriched: [], nightly: [], unhealed: [] }

  log(`\nMerged ${merged} pull request(s). Read the report, then run run-publish --apply.`)
  const open = report.openPullRequests
  if (open.length > 0) {
    log(`${open.length} pull request(s) are open and waiting for you: ${open.map((k) => `#${k.pr}`).join(', ')}`)
  }
  return { exitCode: groups.length > 0 ? 2 : 0, report }
}

main()
  .then(async ({ exitCode, report }) => {
    const dir = path.join(REPO_ROOT, 'backend', 'logs')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `prepublish-review-${report.startedAt.replace(/[:.]/g, '-')}.json`)
    await writeFile(file, JSON.stringify(report, null, 2))
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else log(`\nReport: ${file}`)
    process.exit(exitCode)
  })
  .catch((err) => {
    console.error(`run-prepublish-review failed: ${err.stack || err.message}`)
    process.exit(1)
  })
