import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getRegistrationEvent, saveRegistrationSection } from '../lib/organizer.js'
import { createAutosave } from '../lib/autosave.js'

// One registration event for the organizer wizard: the load, and an autosave
// per section. Steps keep their own form state (seeded once from `event`) and
// queue whole section values; after every successful save the event is read
// again so the stepper and checklist follow, without touching the forms.
export default function useRegistrationEvent(eventId) {
  const [load, setLoad] = useState({ ready: false, event: null, error: null, notFound: false })
  const autosaveRef = useRef(null)

  const fetchEvent = useCallback(async () => {
    try {
      const event = await getRegistrationEvent(eventId)
      setLoad({ ready: true, event, error: null, notFound: false })
    } catch (err) {
      setLoad((prev) => (prev.event && err.status !== 404
        ? prev // a failed refresh keeps what is on screen
        : { ready: true, event: null, error: err.message, notFound: err.status === 404 || err.status === 403 }))
    }
  }, [eventId])

  if (!autosaveRef.current) {
    autosaveRef.current = createAutosave({
      save: async (section, value) => {
        await saveRegistrationSection(eventId, section, value)
        fetchEvent()
      },
    })
  }
  const autosave = autosaveRef.current

  useEffect(() => { fetchEvent() }, [fetchEvent])

  // Leaving the editor or the tab saves what is queued (keepalive requests
  // survive the unload). While anything is unsaved, a reload or close asks
  // first, so an edit typed a moment before is not lost silently.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') autosave.flush() }
    const onBeforeUnload = (e) => {
      if (!autosave.hasPending()) return
      autosave.flush()
      e.preventDefault()
      e.returnValue = ''
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      autosave.flush()
    }
  }, [autosave])

  const saveState = useSyncExternalStore(autosave.subscribe, () => autosave.state)

  return {
    ...load,
    saveState,
    queue: autosave.queue,
    flush: autosave.flush,
    reload: fetchEvent,
  }
}
