import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllRows } from '../src/lib/fetchAllRows.js'

// A fake PostgREST client: the table holds `total` rows, and a response never
// carries more than 1000 of them, as on the real server.
function fakeClient(total, { failOnPage = null } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1, source_id: `s${i + 1}` }))
  const calls = []
  const client = {
    calls,
    from(table) {
      const q = { table, order: null }
      const builder = {
        select(cols) { q.cols = cols; return builder },
        order(col) { q.order = col; return builder },
        range(from, to) {
          calls.push({ ...q, from, to })
          if (failOnPage !== null && calls.length - 1 === failOnPage) {
            return Promise.resolve({ data: null, error: { message: 'boom' } })
          }
          const end = Math.min(to, from + 999)
          return Promise.resolve({ data: rows.slice(from, end + 1), error: null })
        },
      }
      return builder
    },
  }
  return client
}

test('fetchAllRows reads 1000 + 1000 + 3 rows in three ordered pages', async () => {
  const client = fakeClient(2003)
  const rows = await fetchAllRows(() => client.from('scraper_b4sport').select('source_id').order('id'))
  assert.equal(rows.length, 2003)
  assert.equal(new Set(rows.map(r => r.id)).size, 2003)
  assert.deepEqual(client.calls.map(c => [c.from, c.to]), [[0, 999], [1000, 1999], [2000, 2999]])
  assert.ok(client.calls.every(c => c.order === 'id'))
})

test('fetchAllRows stops after one short page', async () => {
  const client = fakeClient(3)
  const rows = await fetchAllRows(() => client.from('t').select('*').order('id'))
  assert.equal(rows.length, 3)
  assert.equal(client.calls.length, 1)
})

test('fetchAllRows asks once more when the table is an exact multiple of the page', async () => {
  const client = fakeClient(2000)
  const rows = await fetchAllRows(() => client.from('t').select('*').order('id'))
  assert.equal(rows.length, 2000)
  assert.equal(client.calls.length, 3)
})

test('fetchAllRows throws instead of returning a partial read', async () => {
  const client = fakeClient(2003, { failOnPage: 1 })
  await assert.rejects(
    fetchAllRows(() => client.from('scraper_x').select('*').order('id')),
    /boom/,
  )
})
