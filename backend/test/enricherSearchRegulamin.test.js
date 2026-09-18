import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// search.py is Python, so its own assertions live in enricher/tests. This runs
// them from the backend suite, because the rule it guards is the same rule
// pickRegulaminUrl.js enforces for scrapers: a link is the regulamin only if it
// says so. Silesia Ultramarathon, Silesia Marathon, Silesia Half Marathon
// (datasport 12743, 2026-10-04) published with price_from and
// registration_deadline null because the search step wrote
// https://silesiamarathon.pl/start-zapisow-silesia-marathon-2026/ as its
// regulamin_url. That post is a registration announcement, not the rules
// document, and extraction reads the regulamin only.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const enricherDir = join(repoRoot, 'enricher')

// A worktree has no .venv of its own; the one in the main checkout imports the
// package from whichever tree pytest runs in, so fall back to it.
function findPython() {
  const candidates = [join(enricherDir, '.venv/bin/python')]
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    candidates.push(join(dirname(gitCommonDir), 'enricher/.venv/bin/python'))
  } catch {
    // not a git checkout — the local .venv or PATH is all we have
  }
  candidates.push('python3')

  for (const python of candidates) {
    if (python !== 'python3' && !existsSync(python)) continue
    const probe = spawnSync(python, ['-c', 'import pytest, respx'], { encoding: 'utf8' })
    if (probe.status === 0) return python
  }
  return null
}

const python = findPython()
const skip = python ? false : 'no Python env with pytest and respx (see enricher/README.md)'

test('the search step only accepts a hit that declares itself a regulamin', { skip }, () => {
  const run = spawnSync(python, ['-m', 'pytest', 'tests/test_search.py', '-q'], {
    cwd: enricherDir,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})
