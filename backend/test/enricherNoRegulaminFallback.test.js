import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// pipeline.py is Python, so its own assertions live in enricher/tests. This runs
// them from the backend suite, because the rule it guards is a data rule: an
// event whose organizer publishes no regulamin must still get a price. X-RUN
// Wielki Finał (2026-10-04, biegigorskie) published with price_from, price_to
// and registration_deadline null after two enrichment passes, because the
// pipeline crawled https://xrun.pl/produkt/wielki-final-2026/ (60-260 PLN) and
// then dropped it before extraction, regulamin or no regulamin.
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

test('an event with no regulamin still extracts from its registration page', { skip }, () => {
  const run = spawnSync(python, ['-m', 'pytest', 'tests/test_pipeline_no_regulamin.py', '-q'], {
    cwd: enricherDir,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})
