import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickPrNumber, shouldKeepWorktree, needsRevision } from '../scripts/lib/reviewAgents.js'

// Pull request #161 was opened by a fix agent on 2026-09-18 and appears nowhere
// in that run's report. The orchestrator decided whether a pull request existed
// from the agent's own status field, the agent reported something other than
// "fixed", and the branch it had already pushed became invisible. GitHub knows
// what was opened. Ask it.

test('the pull request GitHub lists wins over the one the agent claimed', () => {
  assert.equal(pickPrNumber({ pr_number: 999 }, [{ number: 161, state: 'OPEN' }]), 161)
})

test('an agent that claims a pull request GitHub does not list has none', () => {
  assert.equal(pickPrNumber({ pr_number: 999 }, []), null)
})

test('an agent that reports failure still gets the pull request it opened', () => {
  assert.equal(pickPrNumber({ status: 'failed' }, [{ number: 161, state: 'OPEN' }]), 161)
})

test('a merged pull request is not offered again', () => {
  assert.equal(pickPrNumber({}, [{ number: 150, state: 'MERGED' }]), null)
})

// A worktree is deleted at the end of every run. When the branch still carries an
// unmerged pull request, deleting it throws away the only checkout where that
// change can be revised, which is how #163 and #164 became orphans.
test('a worktree whose pull request is still open is kept', () => {
  assert.equal(shouldKeepWorktree({ outcome: 'request-changes', pr: 164 }), true)
  assert.equal(shouldKeepWorktree({ outcome: 'held-at-merge-cap', pr: 165 }), true)
})

test('a worktree whose work landed or never existed is removed', () => {
  assert.equal(shouldKeepWorktree({ outcome: 'merged', pr: 162 }), false)
  assert.equal(shouldKeepWorktree({ outcome: 'rejected-by-rails', pr: null }), false)
  assert.equal(shouldKeepWorktree({ outcome: 'no-change', pr: null }), false)
})

// A reviewer that asks for changes is asking for changes, not closing the case.
// One revision round is offered, and only one, so a pair of agents cannot argue
// with each other all afternoon.
test('request-changes earns one revision', () => {
  assert.equal(needsRevision({ verdict: 'request-changes' }, 0), true)
  assert.equal(needsRevision({ verdict: 'request-changes' }, 1), false)
})

test('an outright rejection earns none', () => {
  assert.equal(needsRevision({ verdict: 'reject' }, 0), false)
  assert.equal(needsRevision({ verdict: 'approve' }, 0), false)
})
