// Client side of the checkpoint-write edge function: the volunteer page's
// only way to record a pass. The checkpoint PIN rides along with every call,
// because checkpoint_observations no longer takes inserts from the
// publishable key.

const PIN_PREFIX = 'leszy.checkpointPin:'

/**
 * POST to checkpoint-write. The result has the { data, error, status } shape
 * classifyInsertResult() reads: a fetch that never got an answer comes back
 * with an empty error code, which it treats as transient.
 */
export async function checkpointWrite(base, body, { signal, fetchImpl = fetch } = {}) {
  let res
  try {
    res = await fetchImpl(`${base}/checkpoint-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    return { data: null, error: { code: '', message: err?.message || 'network error' }, status: 0 }
  }
  const json = await res.json().catch(() => ({}))
  if (res.ok) return { data: json.data ?? null, error: null, status: res.status }
  return { data: null, error: { code: json.code ?? '', message: json.error || `HTTP ${res.status}` }, status: res.status }
}

/** 'ok' | 'invalid' | 'locked' | 'unknown' (no answer: offline in the forest) */
export function pinCheckOutcome({ error, status }) {
  if (!error) return 'ok'
  if (status === 401) return 'invalid'
  if (status === 429) return 'locked'
  return 'unknown'
}

function store(storage) {
  try { return storage ?? window.localStorage } catch { return null }
}

export function readPin(checkpointId, storage) {
  try { return store(storage)?.getItem(PIN_PREFIX + checkpointId) || null } catch { return null }
}

export function savePin(checkpointId, pin, storage) {
  try { store(storage)?.setItem(PIN_PREFIX + checkpointId, pin) } catch { /* the page still works for this visit */ }
}

export function clearPin(checkpointId, storage) {
  try { store(storage)?.removeItem(PIN_PREFIX + checkpointId) } catch { /* nothing stored */ }
}
