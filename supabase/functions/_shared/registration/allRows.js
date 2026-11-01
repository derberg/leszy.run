// PostgREST caps one response at 1000 rows, so every list read pages through this. Plain ESM.
export const PAGE = 1000

/**
 * Every row of a query, PAGE at a time. `makeQuery` builds a fresh query each call, ordered on a
 * unique key, so the pages neither overlap nor skip a row.
 * @param {() => { range: (from: number, to: number) => PromiseLike<{ data: object[], error: object|null }> }} makeQuery
 */
export async function allRows(makeQuery) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...data)
    if (data.length < PAGE) return out
  }
}
