import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// pipeline.py is Python, so its own assertions live in enricher/tests. This runs
// them from the backend suite. Kamieński Bieg Niepodległości (2026-11-11,
// maratonypolskie:91322) has only a website, a kamienskie.info article that says
// 'bieg główny na dystansie 5 kilometrów'. The pipeline never crawled `website`,
// so the row published with distances null. VI Biegowe Grand Prix Krainy Dobrej
// Energii (2026-11-29) links its regulamin PDF only from its website, which
// discovery never read.
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

test('an event with no regulamin reads its own website', { skip }, () => {
  const run = spawnSync(python, ['-m', 'pytest', 'tests/test_pipeline_website.py', '-q'], {
    cwd: enricherDir,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})
