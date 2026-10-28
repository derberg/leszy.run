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

  // Leaving the editor or the tab saves what is queued.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') autosave.flush() }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
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
