// PostgREST caps every response at 1000 rows and says nothing when it does, so
// a whole-table read without paging silently loses everything past row 1000.
//
// `buildQuery` returns a fresh query (select + filters + an explicit order) for
// each page; this adds `.range()` and keeps reading until a short page. The
// caller must order by a unique column (`id`): without an ORDER BY, Postgres
// does not promise the same row order on two requests, so offset pages can skip
// or repeat rows.
//
// An error throws rather than returning the pages read so far, because a
// partial read looks exactly like a smaller table.

/**
 * @param {() => { range: (from: number, to: number) => PromiseLike<{ data: any[] | null, error: { message: string } | null }> }} buildQuery
 * @param {{ pageSize?: number, label?: string }} [opts]
 * @returns {Promise<any[]>}
 */
export async function fetchAllRows(buildQuery, { pageSize = 1000, label = 'read' } = {}) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}
