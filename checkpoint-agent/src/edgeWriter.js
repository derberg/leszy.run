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
//
// A PIN the server refuses is remembered and not sent again until a different
// one is stored. Every wrong PIN counts towards the event's lockout (100 per
// 15 minutes, per event, not per caller), so a Pi left with a regenerated or
// mistyped PIN, uploading every 5 s and beating every 15 s, would otherwise
// lock the PIN for every volunteer and every other Pi within minutes.

const TIMEOUT_MS = 15000

export function createEdgeWriter({ supabaseUrl, anonKey, getPin, fetchImpl = fetch }) {
  let rejectedPin = null

  async function call(body) {
    const pin = await getPin()
    if (!pin) return { data: null, error: { message: 'No checkpoint PIN stored' } }
    if (pin === rejectedPin) {
      return { data: null, error: { code: 'invalid_pin', message: 'Checkpoint PIN rejected; set up the checkpoint again with the current PIN' } }
    }
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
    if (res.status === 401) rejectedPin = pin
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
