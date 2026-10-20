import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildResultsSnapshot, categoryView, latestRun, nearFinishInputs, isLive } from '../../src/lib/resultsSnapshot.js'

// A Supabase client over in-memory tables that understands the calls the
// builder makes. Every page read is logged as "<table> <from>".
function fakeSupabase(tables, { failOn } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      const filters = []
      const builder = {
        select: () => builder,
        order: () => builder,
        eq: (col, v) => { filters.push(r => r[col] === v); return builder },
        in: (col, vs) => { filters.push(r => vs.includes(r[col])); return builder },
        range: async (from, to) => {
          reads.push(`${table} ${from}`)
          if (table === failOn) return { data: null, error: { message: 'boom' } }
          const rows = (tables[table] || []).filter(r => filters.every(f => f(r)))
          return { data: rows.slice(from, to + 1), error: null }
        },
      }
      return builder
    },
  }
}

const tables = {
  categories: [
    { id: 'c10', event_id: 'e1', name: '10 km', untimed: false },
    { id: 'cx', event_id: 'e2', name: 'other event', untimed: false },
  ],
  checkpoints: [{ id: 'cp1', event_id: 'e1', name: '5 km', km_marker: 5, private: false, is_near_finish: false }],
  checkpoint_categories: [],
  race_runs: [
    { id: 'old', category_id: 'c10', status: 'cancelled', created_at: '2026-10-17T08:00:00Z' },
    { id: 'run', category_id: 'c10', status: 'active', started_at: '2026-10-17T09:00:00Z', created_at: '2026-10-17T08:55:00Z' },
  ],
  participants_public: [{ id: 'p1', category_id: 'c10', bib_number: 7, first_name: 'Anna' }],
  results: [
    { id: 'r-old', race_run_id: 'old', participant_id: 'p1', status: 'started' },
    { id: 'r1', race_run_id: 'run', participant_id: 'p1', status: 'finished', finish_time: 'f' },
  ],
  checkpoint_observations: [{ id: 'o1', checkpoint_id: 'cp1', participant_id: 'p1', bib_number: 7, observed_at: '2026-10-17T09:20:00Z' }],
}

describe('buildResultsSnapshot', () => {
  it('reads only the event and only the results of started runs', async () => {
    const snap = await buildResultsSnapshot(fakeSupabase(tables), 'e1')
    assert.deepEqual(snap.categories.map(c => c.id), ['c10'])
    assert.deepEqual(snap.raceRuns.map(r => r.id).sort(), ['old', 'run'])
    assert.deepEqual(snap.results.map(r => r.id), ['r1'])
    assert.equal(snap.observations.length, 1)
  })

  it('leaves out what the page never shows: untimed categories, private checkpoints, reads before the gun', async () => {
    const snap = await buildResultsSnapshot(fakeSupabase({
      ...tables,
      categories: [...tables.categories, { id: 'kids', event_id: 'e1', name: 'Bieg dziecięcy', untimed: true }],
      participants_public: [...tables.participants_public, { id: 'child', category_id: 'kids', bib_number: 900 }],
      checkpoints: [
        ...tables.checkpoints,
        { id: 'meta', event_id: 'e1', name: 'Meta', private: true, is_near_finish: false },
        { id: 'nf', event_id: 'e1', name: 'Tuż tuż', private: true, is_near_finish: true },
      ],
      checkpoint_observations: [
        ...tables.checkpoint_observations,
        { id: 'manual', checkpoint_id: 'meta', participant_id: 'p1', bib_number: 7, observed_at: '2026-10-17T10:30:00Z' },
        { id: 'near', checkpoint_id: 'nf', participant_id: 'p1', bib_number: 7, observed_at: '2026-10-17T10:25:00Z' },
        { id: 'ghost', checkpoint_id: 'cp1', participant_id: 'p1', bib_number: 7, observed_at: '2026-10-17T08:30:00Z' },
      ],
    }), 'e1')
    assert.deepEqual(snap.categories.map(c => c.id), ['c10'])
    assert.deepEqual(snap.participants.map(p => p.id), ['p1'])
    assert.deepEqual(snap.checkpoints.map(c => c.id).sort(), ['cp1', 'nf'])
    assert.deepEqual(snap.observations.map(o => o.id).sort(), ['near', 'o1'])
  })

  it('carries no observations before any run has started', async () => {
    const snap = await buildResultsSnapshot(fakeSupabase({ ...tables, race_runs: [] }), 'e1')
    assert.deepEqual(snap.observations, [])
  })

  it('reads past the 1000-row page PostgREST returns', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}`, category_id: 'c10' }))
    const sb = fakeSupabase({ ...tables, participants_public: many })
    const snap = await buildResultsSnapshot(sb, 'e1')
    assert.equal(snap.participants.length, 2500)
    assert.deepEqual(sb.reads.filter(r => r.startsWith('participants_public')),
      ['participants_public 0', 'participants_public 1000', 'participants_public 2000'])
  })

  it('skips the dependent reads for an event with no categories or checkpoints', async () => {
    const sb = fakeSupabase(tables)
    const snap = await buildResultsSnapshot(sb, 'no-such-event')
    assert.deepEqual(sb.reads.sort(), ['categories 0', 'checkpoints 0'])
    assert.deepEqual(snap.results, [])
  })

  it('throws when Supabase answers with an error, so the handler never caches a partial snapshot', async () => {
    await assert.rejects(buildResultsSnapshot(fakeSupabase(tables, { failOn: 'results' }), 'e1'), /boom/)
  })
})

describe('isLive', () => {
  it('is live only while a run is active', () => {
    assert.equal(isLive({ raceRuns: [{ status: 'finished' }, { status: 'active' }] }), true)
    assert.equal(isLive({ raceRuns: [{ status: 'finished' }, { status: 'pending' }] }), false)
  })
})

describe('latestRun', () => {
  it('takes the newest active or finished run and ignores cancelled and pending ones', () => {
    const runs = [
      { id: 'a', category_id: 'c', status: 'finished', created_at: '2026-01-01T10:00:00Z' },
      { id: 'b', category_id: 'c', status: 'active', created_at: '2026-01-01T11:00:00Z' },
      { id: 'c', category_id: 'c', status: 'cancelled', created_at: '2026-01-01T12:00:00Z' },
      { id: 'd', category_id: 'c', status: 'pending', created_at: '2026-01-01T13:00:00Z' },
    ]
    assert.equal(latestRun(runs, 'c').id, 'b')
    assert.equal(latestRun(runs, 'other'), null)
  })
})

describe('categoryView', () => {
  const run = { id: 'run', category_id: 'c10', status: 'active', started_at: '2026-10-17T09:00:00Z', created_at: '2026-10-17T08:55:00Z' }
  const base = {
    categories: [{ id: 'c10', name: '10 km' }, { id: 'c21', name: '21 km' }],
    checkpoints: [
      { id: 'cp10', name: '10 km', km_marker: 10, private: false },
      { id: 'cp5', name: '5 km', km_marker: 5, private: false },
      { id: 'hidden', name: 'meta', km_marker: 9, private: true },
      { id: 'only21', name: '15 km', km_marker: 15, private: false },
    ],
    checkpointCategories: [{ checkpoint_id: 'only21', category_id: 'c21' }],
    raceRuns: [run],
    participants: [
      { id: 'p1', category_id: 'c10', bib_number: 1, first_name: 'Anna', last_name: 'A' },
      { id: 'p2', category_id: 'c21', bib_number: 2, first_name: 'Ola', last_name: 'B' },
    ],
    results: [{ id: 'r1', race_run_id: 'run', participant_id: 'p1', start_time: 's', finish_time: null, duration_ms: null, gun_duration_ms: null, status: 'started' }],
    observations: [
      { id: 'ghost', checkpoint_id: 'cp5', participant_id: 'p1', bib_number: 1, observed_at: '2026-10-17T08:59:59Z' },
      { id: 'real', checkpoint_id: 'cp5', participant_id: 'p1', bib_number: 1, observed_at: '2026-10-17T09:20:00Z' },
      { id: 'other-cat', checkpoint_id: 'cp5', participant_id: 'p2', bib_number: 2, observed_at: '2026-10-17T09:21:00Z' },
      { id: 'unmatched', checkpoint_id: 'cp10', participant_id: null, bib_number: 99, observed_at: '2026-10-17T09:40:00Z' },
      { id: 'private', checkpoint_id: 'hidden', participant_id: 'p1', bib_number: 1, observed_at: '2026-10-17T09:50:00Z' },
    ],
  }

  it('is not loaded before the first snapshot arrives', () => {
    assert.equal(categoryView(null, 'c10').loaded, false)
  })

  it('shows public checkpoints the category passes, ordered by km', () => {
    assert.deepEqual(categoryView(base, 'c10').checkpoints.map(c => c.id), ['cp5', 'cp10'])
    assert.deepEqual(categoryView(base, 'c21').checkpoints.map(c => c.id), ['cp5', 'cp10', 'only21'])
  })

  it('joins each result to its participant in the shape the shared UI reads', () => {
    const v = categoryView(base, 'c10')
    assert.equal(v.raceRun.id, 'run')
    assert.equal(v.results[0].participantId, 'p1')
    assert.equal(v.results[0].startTime, 's')
    assert.equal(v.results[0].participant.firstName, 'Anna')
    assert.equal(v.results[0].participant.bibNumber, 1)
  })

  it('drops observations from before the gun, from other categories and at private checkpoints', () => {
    assert.deepEqual(categoryView(base, 'c10').observations.map(o => o.id), ['real', 'unmatched'])
    assert.equal(categoryView(base, 'c10').observations[0].observedAt, '2026-10-17T09:20:00Z')
  })

  it('is loaded with no results when the category has no started run', () => {
    const v = categoryView({ ...base, raceRuns: [] }, 'c10')
    assert.equal(v.loaded, true)
    assert.equal(v.raceRun, null)
    assert.deepEqual(v.results, [])
    assert.equal(v.category.name, '10 km')
  })
})

describe('nearFinishInputs', () => {
  it('keeps only the observations at the near-finish checkpoint', () => {
    const snap = { observations: [{ checkpoint_id: 'nf' }, { checkpoint_id: 'cp5' }], participants: [1], results: [2] }
    const inputs = nearFinishInputs(snap, 'nf')
    assert.equal(inputs.observations.length, 1)
    assert.deepEqual(inputs.participants, [1])
    assert.deepEqual(inputs.results, [2])
  })
})
