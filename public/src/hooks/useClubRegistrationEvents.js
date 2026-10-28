import { useCallback, useEffect, useState } from 'react'
import { listClubRegistrationEvents } from '../lib/organizer.js'

// The club's registration events for the „Wydarzenia” tab. `enabled` is false
// until organizer-status says the list can be read (registration on, agreement
// accepted); until then nothing is fetched and the list is empty. `null`
// means not known yet: the hook stays not ready.
export default function useClubRegistrationEvents(clubId, enabled) {
  const [state, setState] = useState({ ready: false, events: [], error: null })

  const load = useCallback(async () => {
    if (enabled === null) return
    if (!enabled) {
      setState({ ready: true, events: [], error: null })
      return
    }
    try {
      setState({ ready: true, events: await listClubRegistrationEvents(clubId), error: null })
    } catch (err) {
      setState({ ready: true, events: [], error: err.message })
    }
  }, [clubId, enabled])

  useEffect(() => { load() }, [load])

  return { ...state, reload: load }
}
