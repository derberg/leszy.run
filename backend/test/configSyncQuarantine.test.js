import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newSkipSets, isTestRow, rememberSkipped } from '../src/sync/configSync.js'

// Regression: the edge-function suite (supabase/functions/tests/) writes throwaway
// `events`/`participants` rows into the SAME production Supabase project this worker polls.
// Those rows outlive the 30 s poll, get pulled into every backend host's local Postgres, and
// because configSync never propagates deletes, the suite's own cleanup can never remove them
// again — they are stranded locally forever. Two `[e2e-test] roster test` events were found
// that way (absent from Supabase, still present locally). The filter below is what stops it.

// Mirrors how pullConfig walks PULL_TABLES: parents first, remembering each refusal.
function pull(tables) {
  const skip = newSkipSets()
  const kept = []
  for (const { name, rows } of tables) {
    for (const remote of rows) {
      if (isTestRow(name, remote, skip)) { rememberSkipped(name, remote, skip); continue }
      kept.push({ name, id: remote.id })
    }
  }
  return kept.map((r) => `${r.name}:${r.id}`)
}

test('refuses a marker-tagged event and every row hanging off it', () => {
  const kept = pull([
    { name: 'events', rows: [
      { id: 'ev-real', name: 'Nocny Zew Wilka' },
      { id: 'ev-test', name: '[e2e-test] roster test' },
    ] },
    { name: 'categories', rows: [
      { id: 'cat-real', event_id: 'ev-real' },
      { id: 'cat-test', event_id: 'ev-test' },
    ] },
    { name: 'participants', rows: [
      { id: 'p-real', event_id: 'ev-real' },
      { id: 'p-test', event_id: 'ev-test' },
    ] },
    { name: 'checkpoints', rows: [{ id: 'cp-test', event_id: 'ev-test' }] },
    { name: 'race_runs', rows: [
      { id: 'rr-real', category_id: 'cat-real' },
      { id: 'rr-test', category_id: 'cat-test' },
    ] },
    { name: 'results', rows: [
      { id: 'res-real', race_run_id: 'rr-real' },
      { id: 'res-test', race_run_id: 'rr-test' },
    ] },
    { name: 'event_documents', rows: [{ id: 'doc-test', event_id: 'ev-test' }] },
  ])

  assert.deepEqual(kept, [
    'events:ev-real', 'categories:cat-real', 'participants:p-real',
    'race_runs:rr-real', 'results:res-real',
  ])
})

test('a real event whose name merely contains the marker text is still pulled', () => {
  const skip = newSkipSets()
  // Only a PREFIX match is test data — the marker is prepended by the suite, never infixed.
  assert.equal(isTestRow('events', { id: 'e', name: 'Bieg [e2e-test] w nazwie' }, skip), false)
})

test('tolerates events with a missing or non-string name', () => {
  const skip = newSkipSets()
  assert.equal(isTestRow('events', { id: 'e' }, skip), false)
  assert.equal(isTestRow('events', { id: 'e', name: null }, skip), false)
})

test('orphan children of an already-absent test event are not refused by accident', () => {
  // Nothing was skipped, so nothing cascades — a child with an unknown parent is real data.
  const skip = newSkipSets()
  assert.equal(isTestRow('participants', { id: 'p', event_id: 'ev-unknown' }, skip), false)
})
