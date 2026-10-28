import { useState, useEffect, useCallback } from 'react'
import { organizerStatus } from '../lib/organizer.js'

// The club's organizer state (enabled / waitlisted / agreement / payout) for
// the "Wydarzenia" tab. Component-local, like useClub.
export default function useOrganizerStatus(clubId) {
  const [state, setState] = useState({ ready: false, status: null, error: null })

  const load = useCallback(async () => {
    try {
      const status = await organizerStatus(clubId)
      setState({ ready: true, status, error: null })
    } catch (err) {
      setState({ ready: true, status: null, error: err.message })
    }
  }, [clubId])

  useEffect(() => { load() }, [load])

  return { ...state, reload: load }
}
