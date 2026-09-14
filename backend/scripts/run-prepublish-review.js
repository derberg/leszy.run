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
  checkDiffPaths,
  countBlastRadius,
  mapWithConcurrency,
} from './lib/reviewAgents.js'
import { diagnosePrompt, fixPrompt, reviewPrompt } from './lib/reviewPrompts.js'

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

// Phase 0. Which events would publish incomplete.
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
  return notReady.slice(0, LIMIT)
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
    if (!res.ok || !res.json) {
      log(`      ? ${candidate.name}: ${res.error || 'no JSON returned'}`)
      return null
    }
    const finding = {
      ...res.json,
      event: {
        name: candidate.name,
        date: candidate.date,
        source: candidate.source,
        source_id: candidate.source_id,
      },
      costUsd: res.costUsd,
    }
    const mark = { 'code-defect': 'X', 'absent-at-source': '-', 'needs-human': '?' }[finding.verdict] || '?'
    log(`      ${mark} ${candidate.name}: ${finding.summary || finding.verdict}`)
    return finding
  })
  return results.filter(Boolean)
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
    log(`      ${group.file} (${group.layer}): ${group.findings.length} event(s)`
      + (measured.count != null ? `, ${measured.count} row(s) share it` : ''))
  }
  return groups
}

// Phase 3. One agent per defect, each in its own worktree.
async function fixAll(groups) {
  log(`\n[3/5] Fixing ${groups.length} defect(s), ${FIX_CONCURRENCY} at a time...`)
  return mapWithConcurrency(groups, FIX_CONCURRENCY, async (group) => {
    const branch = `fix/auto-${branchSlug(group.key)}`.slice(0, 80)
    let worktree
    try {
      sh('bash', ['scripts/worktree.sh', 'new', branch], { cwd: MAIN_ROOT })
      worktree = path.join(MAIN_ROOT, '.worktrees', branch.replace(/\//g, '-'))
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
async function reviewAndMerge(fixes) {
  log(`\n[4/5] Reviewing ${fixes.length} pull request(s)...`)
  let merged = 0
  const outcomes = []

  for (const fix of fixes) {
    const record = { file: fix.group.file, branch: fix.branch, pr: fix.agent?.pr_number ?? null }

    const check = verifyFix(fix)
    if (!check.ok) {
      log(`      REJECTED ${fix.group.file}: ${check.problems[0]}`)
      outcomes.push({ ...record, outcome: 'rejected-by-rails', problems: check.problems })
      continue
    }

    let diff = ''
    try {
      diff = sh('git', ['diff', 'origin/main...HEAD'], { cwd: fix.worktree }).slice(0, 60000)
    } catch {
      outcomes.push({ ...record, outcome: 'rejected-by-rails', problems: ['no diff'] })
      continue
    }

    const res = await runAgent({
      prompt: reviewPrompt({ group: fix.group, diff, prNumber: record.pr ?? 0 }),
      cwd: fix.worktree,
      allowedTools: REVIEW_TOOLS,
      model: 'opus',
    })
    const verdict = res.json || { verdict: 'request-changes', reasoning: res.error || 'the reviewer returned nothing' }
    record.review = verdict

    if (verdict.verdict !== 'approve') {
      log(`      ${String(verdict.verdict).toUpperCase()} ${fix.group.file}: ${verdict.reasoning}`)
      outcomes.push({ ...record, outcome: verdict.verdict })
      continue
    }
    if (merged >= MAX_MERGES) {
      log(`      HELD ${fix.group.file}: the merge cap of ${MAX_MERGES} is reached`)
      outcomes.push({ ...record, outcome: 'held-at-merge-cap' })
      continue
    }
    if (!record.pr) {
      outcomes.push({ ...record, outcome: 'approved-but-no-pr' })
      continue
    }
    try {
      const [ghArgs, gitArgs] = mergeCommands(record.pr, fix.branch)
      sh('gh', ghArgs, { cwd: fix.worktree })
      merged++
      // The branch is gone from the remote, but the merge already counted, so a
      // failure to tidy up is not a failure to merge.
      try { sh('git', gitArgs, { cwd: fix.worktree }) } catch {}
      log(`      MERGED #${record.pr} ${fix.group.file}`)
      outcomes.push({ ...record, outcome: 'merged' })
    } catch (err) {
      outcomes.push({ ...record, outcome: 'merge-failed', problems: [err.message.slice(0, 200)] })
    }
  }

  for (const fix of fixes) {
    try { sh('bash', ['scripts/worktree.sh', 'rm', fix.branch], { cwd: MAIN_ROOT }) } catch {}
  }
  return { outcomes, merged }
}

// Phase 5. Re-scrape so the corrected code rewrites the rows.
//
// run-merge only reads raw rows where merged_at IS NULL, so a re-scrape on its
// own leaves scraper_all holding the old value. The stamp is cleared for the
// affected source and only for events that have not happened yet, which is the
// set worth rebuilding.
async function healSources(mergedOutcomes) {
  const sources = [...new Set(
    mergedOutcomes
      .filter((o) => o.outcome === 'merged')
      .map((o) => /backend\/src\/scrapers\/sources\/([a-z0-9]+)\.js$/.exec(o.file)?.[1])
      .filter(Boolean)
  )]
  if (sources.length === 0) {
    log('\n[5/5] No source scraper changed, so there is nothing to re-scrape.')
    return { sources: [], ran: false }
  }
  log(`\n[5/5] Re-scraping ${sources.join(', ')} so the fixed code rewrites the rows...`)
  const today = new Date().toISOString().slice(0, 10)
  const list = sources.join(',')
  const backend = path.join(MAIN_ROOT, 'backend')
  sh('git', ['pull', '--ff-only'], { cwd: MAIN_ROOT })
  sh('node', ['--env-file=../.env', 'scripts/run-scrapers.js', '--only', list, '--force', list], { cwd: backend, stdio: 'inherit' })
  for (const source of sources) {
    const { error } = await supabase.from(`scraper_${source}`).update({ merged_at: null }).gte('date', today)
    if (error) log(`      ! could not clear merged_at on scraper_${source}: ${error.message}`)
  }
  sh('node', ['--env-file=../.env', 'scripts/run-merge.js', '--apply'], { cwd: backend, stdio: 'inherit' })
  sh('node', ['--env-file=../.env', 'scripts/run-normalize.js', '--apply'], { cwd: backend, stdio: 'inherit' })
  return { sources, ran: true }
}

async function main() {
  const startedAt = new Date().toISOString()
  const selected = await selectCandidates()
  if (selected.length === 0) {
    log('\nEvery row that would publish is ready to accept. There is nothing to review.')
    return { exitCode: 0, report: { startedAt, candidates: [], findings: [], defects: [] } }
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
  const groups = await reconcile(findings)
  const report = {
    startedAt,
    apply,
    candidates: candidates.map((c) => ({ name: c.name, date: c.date, source: c.source, missing: c.missing_required })),
    undiagnosable: undiagnosable.map((u) => ({ name: u.candidate?.name, date: u.candidate?.date, reason: u.reason })),
    findings,
    defects: groups.map((g) => ({ file: g.file, layer: g.layer, events: g.events.length, blastRadius: g.blastRadius, signatures: g.signatures })),
    costUsd: findings.reduce((sum, f) => sum + (f.costUsd || 0), 0),
  }

  if (!apply) {
    log('\nDry run. No pull request was opened. Pass --apply to let the fix agents work.')
    return { exitCode: groups.length > 0 ? 2 : 0, report }
  }

  const fixes = (await fixAll(groups)).filter((f) => f.status === 'fixed')
  const { outcomes, merged } = await reviewAndMerge(fixes)
  report.pullRequests = outcomes
  report.merged = merged
  report.heal = heal && merged > 0 ? await healSources(outcomes) : { sources: [], ran: false }

  log(`\nMerged ${merged} pull request(s). Read the report, then run run-publish --apply.`)
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
