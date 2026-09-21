import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planFixAttempt } from '../scripts/lib/reviewAgents.js'

// A branch name is derived from the defect, so the same defect asks for the same
// branch every run. Keeping the worktree of an open pull request (so the change
// can still be revised) therefore collides with the next run, which calls
// worktree.sh new on a branch that is already checked out and gets an error
// instead of a fix. Decide what to do with the branch before creating anything.

test('an open pull request is left alone, not re-fixed', () => {
  const plan = planFixAttempt({
    branch: 'fix/auto-enricher-geocoder',
    prs: [{ number: 164, state: 'OPEN' }],
    worktreeExists: true,
  })
  assert.equal(plan.action, 'skip-open-pr')
  assert.equal(plan.pr, 164)
})

// The previous run already offered a fix and a revision, and a reviewer objected
// to both. Sending a third agent at it blind spends money to repeat the argument.
test('the reason names the pull request so a person can pick it up', () => {
  const plan = planFixAttempt({ branch: 'b', prs: [{ number: 164, state: 'OPEN' }], worktreeExists: false })
  assert.match(plan.reason, /#164/)
})

test('a branch whose pull request merged is cleared out of the way', () => {
  const plan = planFixAttempt({ branch: 'b', prs: [{ number: 162, state: 'MERGED' }], worktreeExists: true })
  assert.equal(plan.action, 'reset')
})

// A branch left behind by a run that was rejected by the rails has no pull
// request at all. It still occupies the name, so it is removed before the new
// worktree is made.
test('a leftover branch with no pull request is cleared out of the way', () => {
  assert.equal(planFixAttempt({ branch: 'b', prs: [], worktreeExists: true }).action, 'reset')
})

test('a defect nobody has attempted yet gets a fresh worktree', () => {
  assert.equal(planFixAttempt({ branch: 'b', prs: [], worktreeExists: false }).action, 'create')
})
