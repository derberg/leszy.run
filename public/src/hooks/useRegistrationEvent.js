import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getRegistrationEvent, saveRegistrationSection } from '../lib/organizer.js'
import { createAutosave } from '../lib/autosave.js'

const IDLE = { savingSections: [], savedAt: null, error: null }
const noSubscribe = () => () => {}
const noop = () => {}
const resolvedTrue = async () => true

// One registration event for the organizer wizard: the load, and an autosave
// per section. Steps keep their own form state (seeded once from `event`) and
// queue whole section values; after every successful save the event is read
// again so the stepper and checklist follow, without touching the forms.
// A step that lists rows queues a function (read when the save starts) and
// registers onSaved(section, handler) to learn the ids the save created.
export default function useRegistrationEvent(eventId) {
  const [load, setLoad] = useState({ ready: false, event: null, error: null, notFound: false })

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

  // Created in the effect, not during render: StrictMode runs effects twice,
  // and an autosave disposed by the first cleanup must not be reused.
  const [autosave, setAutosave] = useState(null)
  // section → what a step does with the save's answer (ids of rows it created)
  const savedHandlers = useRef(new Map())
  const onSaved = useCallback((section, handler) => {
    savedHandlers.current.set(section, handler)
    return () => { if (savedHandlers.current.get(section) === handler) savedHandlers.current.delete(section) }
  }, [])

  useEffect(() => { fetchEvent() }, [fetchEvent])

  // Leaving the editor or the tab saves what is queued (keepalive requests
  // survive the unload). While anything is unsaved, a reload or close asks
  // first, so an edit typed a moment before is not lost silently. Unmounting
  // flushes once more and then disposes, so no retry fires afterwards.
  useEffect(() => {
    const a = createAutosave({
      save: async (section, value) => {
        const data = await saveRegistrationSection(eventId, section, value)
        savedHandlers.current.get(section)?.(data)
        // Awaited: a step opened after flush() seeds from the event as saved.
        await fetchEvent()
      },
    })
    setAutosave(a)
    const onHide = () => { if (document.visibilityState === 'hidden') a.flush() }
    const onBeforeUnload = (e) => {
      if (!a.hasPending()) return
      a.flush()
      e.preventDefault()
      e.returnValue = ''
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      a.flush()
      a.dispose()
    }
  }, [eventId, fetchEvent])

  const saveState = useSyncExternalStore(autosave ? autosave.subscribe : noSubscribe, () => (autosave ? autosave.state : IDLE))

  return {
    ...load,
    ready: load.ready && !!autosave,
    saveState,
    queue: autosave ? autosave.queue : noop,
    flush: autosave ? autosave.flush : resolvedTrue,
    reload: fetchEvent,
    onSaved,
  }
}
