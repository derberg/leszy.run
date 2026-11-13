import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// XXI Bieg Mikołajów i Mikołajek (2026-12-05, maratonypolskie:91269) published
// with no regulamin_url. The enricher downloaded the PDF linked from the MOSiR
// page, read it and matched it to the event, then the merge step dropped it:
// it token-matched the name against the raw, compressed PDF bytes and found
// nothing. The assertion lives in enricher/tests because pipeline.py is Python.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const enricherDir = join(repoRoot, 'enricher')

// A worktree has no .venv of its own; fall back to the main checkout's.
function findPython() {
  const candidates = [join(enricherDir, '.venv/bin/python')]
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    candidates.push(join(dirname(gitCommonDir), 'enricher/.venv/bin/python'))
  } catch {
    // not a git checkout
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

test('a crawled PDF that names the event is stored as the regulamin', { skip }, () => {
  const run = spawnSync(
    python,
    [
      '-m', 'pytest', '-q',
      'tests/test_pipeline_discovered_regulamin.py::test_a_crawled_pdf_that_names_the_event_is_stored_as_the_regulamin',
    ],
    { cwd: enricherDir, encoding: 'utf8' },
  )
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})
