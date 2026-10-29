import { useEffect, useRef, useState } from 'react'
import { FUNCTIONS_BASE } from '../lib/auth.js'
import { createOutbox, classifyInsertResult, outboxKey } from '../lib/checkpointOutbox.js'
import { checkpointWrite } from '../lib/checkpointWrite.js'

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
export function useCheckpointOutbox(checkpointId, pin, onPinRejected) {
  // Created in the effect, not in useMemo: StrictMode runs effects twice, and a
  // memoised outbox would be destroyed by the first cleanup and then reused.
  const [outbox, setOutbox] = useState(null)
  const [, setVersion] = useState(0)
  // Read at send time, so a PIN typed after the page opened (or a corrected
  // one) applies to entries already waiting in the queue.
  const pinRef = useRef(pin)
  pinRef.current = pin
  const rejectedRef = useRef(onPinRejected)
  rejectedRef.current = onPinRejected

  useEffect(() => {
    if (!checkpointId) return
    const ob = makeOutbox(checkpointId, () => pinRef.current, () => rejectedRef.current?.())
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

  // A PIN arriving after entries were queued sends them straight away.
  useEffect(() => { if (pin) outbox?.flush() }, [pin, outbox])

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

// Not a rejection of the entry: it waits until a PIN the server accepts.
function waitForPin(message) {
  const err = new Error(message)
  err.permanent = false
  return err
}

function makeOutbox(checkpointId, getPin, pinRejected) {
  return createOutbox({
    storage: safeStorage(),
    key: outboxKey(checkpointId),
    send: async (entry, signal) => {
      // No PIN yet, or the last one was refused: send nothing. Every wrong
      // PIN counts towards the event's lockout, which would stop every other
      // volunteer and Pi too.
      const pin = getPin()
      if (!pin) throw waitForPin('Brak PIN-u')
      // checkpoint-write answers a dropped row (the trg_checkpoint_obs_priority
      // trigger returns NULL when the (checkpoint_id, bib_number) slot is
      // taken) with an empty list, so a discarded entry never looks saved.
      const res = await checkpointWrite(FUNCTIONS_BASE, {
        action: 'observe',
        checkpoint_id: checkpointId,
        pin,
        observation: {
          id: entry.id,
          bib_number: entry.bib,
          observed_at: entry.observedAt,
          source: 'manual',
        },
      }, { signal })
      if (res.status === 401) {
        pinRejected()
        throw waitForPin('Nieprawidłowy PIN')
      }
      return classifyInsertResult(res)
    },
  })
}
