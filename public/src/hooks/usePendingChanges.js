import { useCallback, useEffect, useRef, useState } from 'react'
import { previewRegistrationChanges } from '../lib/organizer.js'

// What a published event's staged changes would do (preview_changes): the
// diff rows, the notice audience and how many people it would reach. Read
// again whenever the staged row changes (`stamp` = pending.updatedAt).
// Off (`enabled` false) for a draft, a member or nothing staged.
export default function usePendingChanges(eventId, stamp, enabled) {
  const [state, setState] = useState({ preview: null, error: null })
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const preview = await previewRegistrationChanges(eventId)
      if (mine === seq.current) setState({ preview, error: null })
      return preview
    } catch (err) {
      if (mine === seq.current) setState((prev) => ({ preview: prev.preview, error: err.message }))
      return null
    }
  }, [eventId])

  useEffect(() => {
    if (!enabled) {
      seq.current++
      setState({ preview: null, error: null })
      return
    }
    refresh()
  }, [enabled, stamp, refresh])

  return { ...state, refresh }
}
