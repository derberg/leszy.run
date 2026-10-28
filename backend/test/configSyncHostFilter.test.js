import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newSkipSets, isTestRow, rememberSkipped, hostSkipsEvent, loadHostFilter, pullConfig } from '../src/sync/configSync.js'
import { linksToPull } from '../src/sync/checkpointLinks.js'

// A timing host (the Mac, a race Pi) pulls an event only when LESZY.RUN times it and its
// registration is not a draft. An event with no registration_settings row is every event
// that existed before online registration, and it syncs exactly as before.

// Mirrors how pullConfig walks PULL_TABLES: parents first, remembering each refusal.
function pull(tables, filter = {}) {
  const { settingsByEvent = new Map(), knownLocalEventIds = new Set(), settingsFailed = false } = filter
  const skip = newSkipSets()
  const kept = []
  for (const { name, rows } of tables) {
    for (const remote of rows) {
      if (isTestRow(name, remote, skip, settingsByEvent, knownLocalEventIds, settingsFailed)) {
        rememberSkipped(name, remote, skip)
        continue
      }
      kept.push(`${name}:${remote.id}`)
    }
  }
  return kept
}

const settings = (entries) => new Map(entries.map(([id, state, timing_mode]) => [id, { event_id: id, state, timing_mode }]))

test('hostSkipsEvent: no settings row, draft, and non-leszyrun timing', () => {
  assert.equal(hostSkipsEvent(undefined), false)
  assert.equal(hostSkipsEvent({ state: 'draft', timing_mode: 'leszyrun' }), true)
  assert.equal(hostSkipsEvent({ state: 'published', timing_mode: 'external' }), true)
  assert.equal(hostSkipsEvent({ state: 'published', timing_mode: 'none' }), true)
  assert.equal(hostSkipsEvent({ state: 'published', timing_mode: 'leszyrun' }), false)
  assert.equal(hostSkipsEvent({ state: 'closed', timing_mode: 'leszyrun' }), false)
})

test('F-08: an event with no registration_settings row is pulled as today', () => {
  assert.deepEqual(pull([{ name: 'events', rows: [{ id: 'legacy', name: 'Nocny Zew Wilka' }] }]), ['events:legacy'])
})

test('F-08: draft and externally timed events are skipped; published/closed leszyrun ones pulled', () => {
  const kept = pull([{ name: 'events', rows: [
    { id: 'draft', name: 'A' },
    { id: 'ext', name: 'B' },
    { id: 'none', name: 'C' },
    { id: 'pub', name: 'D' },
    { id: 'closed', name: 'E' },
  ] }], { settingsByEvent: settings([
    ['draft', 'draft', 'leszyrun'],
    ['ext', 'published', 'external'],
    ['none', 'published', 'none'],
    ['pub', 'published', 'leszyrun'],
    ['closed', 'closed', 'leszyrun'],
  ]) })
  assert.deepEqual(kept, ['events:pub', 'events:closed'])
})

test('F-09: a skipped event drops every child table', () => {
  const kept = pull([
    { name: 'events', rows: [{ id: 'ev-ok', name: 'OK' }, { id: 'ev-draft', name: 'Draft' }] },
    { name: 'categories', rows: [{ id: 'cat-ok', event_id: 'ev-ok' }, { id: 'cat-d', event_id: 'ev-draft' }] },
    { name: 'participants', rows: [{ id: 'p-ok', event_id: 'ev-ok' }, { id: 'p-d', event_id: 'ev-draft' }] },
    { name: 'checkpoints', rows: [{ id: 'cp-ok', event_id: 'ev-ok' }, { id: 'cp-d', event_id: 'ev-draft' }] },
    { name: 'race_runs', rows: [{ id: 'rr-ok', category_id: 'cat-ok' }, { id: 'rr-d', category_id: 'cat-d' }] },
    { name: 'results', rows: [{ id: 'res-ok', race_run_id: 'rr-ok' }, { id: 'res-d', race_run_id: 'rr-d' }] },
    { name: 'event_documents', rows: [{ id: 'doc-ok', event_id: 'ev-ok' }, { id: 'doc-d', event_id: 'ev-draft' }] },
  ], { settingsByEvent: settings([['ev-draft', 'draft', 'leszyrun']]) })
  assert.deepEqual(kept, [
    'events:ev-ok', 'categories:cat-ok', 'participants:p-ok', 'checkpoints:cp-ok',
    'race_runs:rr-ok', 'results:res-ok', 'event_documents:doc-ok',
  ])
})

test('F-09: the e2e marker quarantine still applies alongside the host filter', () => {
  const kept = pull([{ name: 'events', rows: [{ id: 't', name: '[e2e-test] x' }, { id: 'ok', name: 'OK' }] }],
    { settingsByEvent: settings([['ok', 'published', 'leszyrun']]) })
  assert.deepEqual(kept, ['events:ok'])
})

test('F-10: a refusal is per poll — a draft skipped on poll 1 is pulled on poll 2 once published', () => {
  const tables = [
    { name: 'events', rows: [{ id: 'ev', name: 'Bieg' }] },
    { name: 'categories', rows: [{ id: 'cat', event_id: 'ev' }] },
  ]
  assert.deepEqual(pull(tables, { settingsByEvent: settings([['ev', 'draft', 'leszyrun']]) }), [])
  assert.deepEqual(pull(tables, { settingsByEvent: settings([['ev', 'published', 'leszyrun']]) }),
    ['events:ev', 'categories:cat'])
})

test('settingsFailed: a known local event still pulls, an unknown one is skipped with its children', () => {
  const kept = pull([
    { name: 'events', rows: [{ id: 'known', name: 'K' }, { id: 'new', name: 'N' }] },
    { name: 'categories', rows: [{ id: 'c-known', event_id: 'known' }, { id: 'c-new', event_id: 'new' }] },
  ], { knownLocalEventIds: new Set(['known']), settingsFailed: true })
  assert.deepEqual(kept, ['events:known', 'categories:c-known'])
})

test('settingsFailed never revives an event already marked draft', () => {
  // A failed load discards partial maps, so this combination does not come from
  // loadHostFilter; isTestRow still refuses rather than guessing.
  const kept = pull([{ name: 'events', rows: [{ id: 'known', name: 'K' }] }],
    { settingsByEvent: settings([['known', 'draft', 'leszyrun']]), knownLocalEventIds: new Set(['known']), settingsFailed: true })
  assert.deepEqual(kept, [])
})

// --- loadHostFilter -------------------------------------------------------------------------

function stubSupabase(pages) {
  const calls = []
  return {
    calls,
    from(table) {
      return {
        select(cols) {
          let order = null
          return {
            order(col) { order = col; return this },
            range(from, to) {
              calls.push({ table, cols, order, from, to })
              const i = Math.floor(from / 1000)
              const p = pages[i]
              if (p instanceof Error) return Promise.reject(p)
              return Promise.resolve(p ?? { data: [], error: null })
            },
          }
        },
      }
    },
  }
}

function stubDb(ids) {
  return { select: () => ({ from: () => Promise.resolve(ids.map((id) => ({ id }))) }) }
}

const rows = (n, offset) => Array.from({ length: n }, (_, i) => ({
  event_id: `ev-${offset + i}`, state: 'published', timing_mode: 'leszyrun',
}))

test('loadHostFilter returns every row across two full pages', async () => {
  const sb = stubSupabase([
    { data: rows(1000, 0), error: null },
    { data: rows(1000, 1000), error: null },
    { data: [], error: null },
  ])
  const f = await loadHostFilter(sb, stubDb(['a', 'b']))
  assert.equal(f.settingsFailed, false)
  assert.equal(f.settingsByEvent.size, 2000)
  assert.equal(f.settingsByEvent.get('ev-1999').timing_mode, 'leszyrun')
  assert.deepEqual([...f.knownLocalEventIds].sort(), ['a', 'b'])
  assert.deepEqual(sb.calls.map((c) => [c.table, c.from, c.to]), [
    ['registration_settings', 0, 999], ['registration_settings', 1000, 1999], ['registration_settings', 2000, 2999],
  ])
  assert.match(sb.calls[0].cols, /event_id/)
  // A stable order, so a row inserted mid-walk cannot shift another across a page boundary.
  assert.ok(sb.calls.every((c) => c.order === 'event_id'))
})

test('loadHostFilter stops on a short page', async () => {
  const sb = stubSupabase([{ data: rows(3, 0), error: null }])
  const f = await loadHostFilter(sb, stubDb([]))
  assert.equal(f.settingsByEvent.size, 3)
  assert.equal(sb.calls.length, 1)
})

test('loadHostFilter: an error on page 2 sets settingsFailed and discards the partial map', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const sb = stubSupabase([
    { data: rows(1000, 0), error: null },
    { data: null, error: { message: 'boom' } },
  ])
  const f = await loadHostFilter(sb, stubDb(['a']))
  assert.equal(f.settingsFailed, true)
  assert.equal(f.settingsByEvent.size, 0)
  assert.deepEqual([...f.knownLocalEventIds], ['a'])
  assert.match(logged.mock.calls[0].arguments[0], /registration_settings: boom/)
})

test('loadHostFilter: a thrown fetch also sets settingsFailed', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const sb = stubSupabase([new Error('network down')])
  const f = await loadHostFilter(sb, stubDb(['a']))
  assert.equal(f.settingsFailed, true)
  assert.equal(f.settingsByEvent.size, 0)
  assert.match(logged.mock.calls[0].arguments[0], /network down/)
})

test('checkpoint links never touch a checkpoint absent locally', () => {
  // A checkpoint of a skipped event exists remotely with links but was never pulled.
  const out = linksToPull({
    cleanLocalIds: ['cp-local'],
    remoteCheckpointIds: ['cp-local', 'cp-skipped'],
    localLinks: new Map([['cp-local', ['a']]]),
    remoteLinks: new Map([['cp-local', ['a']], ['cp-skipped', ['x']]]),
  })
  assert.deepEqual(out, [])
})

// --- pullConfig read order ------------------------------------------------------------------

// Supabase where the event row is visible from the start but its draft settings row becomes
// visible only once the events table has been read: the registration flow inserts the event
// first, so a settings read made BEFORE the events read can miss the settings of an event that
// read then sees. pullConfig must read the settings after the events.
function racingSupabase(settingsState) {
  let eventsRead = false
  return {
    from(table) {
      return {
        select() {
          return {
            order() { return this },
            range(from) {
              if (from > 0) return Promise.resolve({ data: [], error: null })
              if (table === 'events') {
                eventsRead = true
                return Promise.resolve({ data: [{ id: 'ev-new', name: 'Nowy bieg' }], error: null })
              }
              if (table === 'registration_settings') {
                const data = eventsRead ? [{ event_id: 'ev-new', state: settingsState, timing_mode: 'leszyrun' }] : []
                return Promise.resolve({ data, error: null })
              }
              return Promise.resolve({ data: [], error: null })
            },
          }
        },
      }
    },
  }
}

function recordingDb() {
  const inserted = []
  const rows = () => Object.assign(Promise.resolve([]), { where: () => Promise.resolve([]) })
  return {
    inserted,
    select: () => ({ from: rows }),
    insert: () => ({
      values: (v) => ({ onConflictDoUpdate: () => { inserted.push(v.id); return Promise.resolve() } }),
    }),
  }
}

test('pullConfig reads registration settings after the events, so a fresh draft is skipped', async (t) => {
  t.mock.method(console, 'log', () => {})
  const db = recordingDb()
  await pullConfig(db, racingSupabase('draft'))
  assert.deepEqual(db.inserted, [])
})

test('pullConfig pulls the same fresh event once its settings say published', async (t) => {
  t.mock.method(console, 'log', () => {})
  const db = recordingDb()
  await pullConfig(db, racingSupabase('published'))
  assert.deepEqual(db.inserted, ['ev-new'])
})

// An events read that fails part-way leaves the events after the failure unjudged, so their
// children would pass as "not refused". The whole poll stops instead: nothing is pulled.
function failingEventsSupabase() {
  return {
    from(table) {
      return {
        select() {
          return {
            order() { return this },
            range(from) {
              if (table === 'events') return Promise.resolve({ data: null, error: { message: 'boom' } })
              if (from > 0) return Promise.resolve({ data: [], error: null })
              if (table === 'registration_settings') {
                return Promise.resolve({ data: [{ event_id: 'ev-draft', state: 'draft', timing_mode: 'leszyrun' }], error: null })
              }
              if (table === 'categories') {
                return Promise.resolve({ data: [{ id: 'cat-1', event_id: 'ev-draft', name: '10 km' }], error: null })
              }
              return Promise.resolve({ data: [], error: null })
            },
          }
        },
      }
    },
  }
}

test('pullConfig: an events read error fails the whole poll, no child row is pulled', async (t) => {
  t.mock.method(console, 'log', () => {})
  const errors = t.mock.method(console, 'error', () => {})
  const db = recordingDb()
  await pullConfig(db, failingEventsSupabase())
  assert.deepEqual(db.inserted, [])
  assert.ok(errors.mock.calls.some((c) => String(c.arguments.join(' ')).includes('boom')))
})
