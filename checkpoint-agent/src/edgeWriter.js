// The agent's writes go through the checkpoint-write edge function, which
// checks the event's checkpoint PIN. They used to be anon-key inserts into
// checkpoint_observations and checkpoint_agents, under policies that let
// anyone with the publishable key forge passes.
//
// This mimics the two supabase-js calls the Uploader and the heartbeat make
// (`from(t).insert(row)` / `from(t).upsert(row)`, both resolving to
// `{ error }`), so neither needed to change. A taken (checkpoint_id,
// bib_number) slot comes back as code 23505, which the Uploader already counts
// as uploaded.

const TIMEOUT_MS = 15000

export function createEdgeWriter({ supabaseUrl, anonKey, getPin, fetchImpl = fetch }) {
  async function call(body) {
    const pin = await getPin()
    if (!pin) return { data: null, error: { message: 'No checkpoint PIN stored' } }
    let res
    try {
      res = await fetchImpl(`${supabaseUrl}/functions/v1/checkpoint-write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}`, apikey: anonKey },
        body: JSON.stringify({ ...body, pin }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      return { data: null, error: { message: err.message } }
    }
    const json = await res.json().catch(() => ({}))
    if (res.ok) return { data: json.data ?? null, error: null }
    return { data: null, error: { code: json.code || String(res.status), message: json.error || `HTTP ${res.status}` } }
  }

  return {
    from(table) {
      if (table === 'checkpoint_observations') {
        return { insert: (row) => call({ action: 'observe', checkpoint_id: row.checkpoint_id, observation: row }) }
      }
      if (table === 'checkpoint_agents') {
        return {
          upsert: (row) => call({
            action: 'heartbeat',
            checkpoint_id: row.checkpoint_id,
            status: row.status,
            reads_total: row.reads_total,
            queue_pending: row.queue_pending,
            unknown_count: row.unknown_count,
          }),
        }
      }
      throw new Error(`edgeWriter: no write path for ${table}`)
    },
  }
}
