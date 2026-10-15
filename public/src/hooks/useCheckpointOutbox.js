import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createOutbox, classifyInsertResult, outboxKey } from '../lib/checkpointOutbox.js'

function safeStorage() {
  try {
    return window.localStorage
  } catch {
    // Some private modes throw on the accessor itself.
    return { getItem: () => { throw new Error('no storage') }, setItem: () => { throw new Error('no storage') } }
  }
}

/**
 * The volunteer page's send queue for one checkpoint. Entries are accepted
 * instantly and delivered in the background; see lib/checkpointOutbox.js.
 */
export function useCheckpointOutbox(checkpointId) {
  // Created in the effect, not in useMemo: StrictMode runs effects twice, and a
  // memoised outbox would be destroyed by the first cleanup and then reused.
  const [outbox, setOutbox] = useState(null)
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!checkpointId) return
    const ob = makeOutbox(checkpointId)
    setOutbox(ob)
    const off = ob.subscribe(() => setVersion(v => v + 1))
    // The browser knows before we do that the signal came back.
    const kick = () => ob.flush()
    const onVisible = () => { if (document.visibilityState === 'visible') ob.flush() }
    // Another tab on the same checkpoint wrote its queue.
    const onStorage = (e) => { if (e.key === outboxKey(checkpointId)) ob.sync() }
    window.addEventListener('online', kick)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      off()
      window.removeEventListener('online', kick)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisible)
      ob.destroy()
      setOutbox(null)
    }
  }, [checkpointId])

  const pending = outbox ? outbox.pendingCount() : 0

  // Closing the tab does not lose the queue (it is in localStorage and resumes
  // on the next visit), but nothing is sent while the page is closed.
  useEffect(() => {
    if (pending === 0) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])

  return {
    ready: !!outbox,
    add: (bib) => outbox?.add(bib),
    cancel: (id) => outbox?.cancel(id),
    retry: (id) => outbox?.retry(id),
    entries: outbox ? outbox.entries() : [],
    pending,
    failed: outbox ? outbox.failedCount() : 0,
    persistent: outbox ? outbox.persistent() : true,
    reachable: outbox ? outbox.reachable() : true,
  }
}

function makeOutbox(checkpointId) {
  return createOutbox({
    storage: safeStorage(),
    key: outboxKey(checkpointId),
    send: async (entry, signal) => {
      // .select() is what makes the outcome observable at all. The
      // trg_checkpoint_obs_priority BEFORE INSERT trigger returns NULL when a
      // row for (checkpoint_id, bib_number) already exists: the insert is
      // dropped and PostgREST reports NO error. Without asking for the row
      // back, a discarded entry looks exactly like a saved one.
      const res = await supabase
        .from('checkpoint_observations')
        .insert({
          id: entry.id,
          checkpoint_id: checkpointId,
          bib_number: entry.bib,
          observed_at: entry.observedAt,
          source: 'manual',
        })
        .select('id')
        .abortSignal(signal)
      return classifyInsertResult(res)
    },
  })
}
