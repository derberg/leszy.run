import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isConventionalTitle, asConventionalTitle } from '../scripts/lib/conventionalTitle.js'

test('Conventional Commits titles pass', () => {
  for (const t of [
    'fix: stop tagging Oleśnica races as trail',
    'feat(registration): team squad edits by the organizer',
    'refactor(scrapers/b4sport)!: drop the old listing',
    'chore(deps): bump vite',
  ]) assert.ok(isConventionalTitle(t), t)
})

test('titles without a known type, colon and description fail', () => {
  for (const t of [
    'Refresh the calendar manifest after the regulamin_url fixes',
    'sts-timing: stop tagging Oleśnica races as trail',
    'Fix: capitalised type',
    'fix:no space',
    'fix: ',
    'fix(): empty scope',
    '',
    undefined,
  ]) assert.equal(isConventionalTitle(t), false, String(t))
})

test('a fix agent title without a type becomes a fix', () => {
  assert.equal(asConventionalTitle('zapisyonline: read the regulamin link'), 'fix: zapisyonline: read the regulamin link')
  assert.equal(asConventionalTitle('fix(enricher): keep the deadline'), 'fix(enricher): keep the deadline')
})
