import { useState, useEffect, useCallback } from 'react'
import useAuth from './useAuth.js'
import { getClub } from '../lib/clubs.js'

// Fetches the caller's active club via get-club. Component-local (not a
// module-level cache like useFavorites) — this is only ever mounted inside
// /profil/klub, so a simple useEffect + state is enough.
//
// get-club returns `{ data: { club: null } }` (200) for callers who are not
// an active member of any club — that's an expected "no club yet" state, not
// an error. Anything else thrown (network failure, 401, etc.) is surfaced via
// `error` so the section can show a real failure message.
export default function useClub() {
  const { user } = useAuth()
  const [state, setState] = useState({ ready: false, club: null, me: null, members: [], followedEvents: [], error: null })

  const load = useCallback(async () => {
    if (!user) { setState({ ready: true, club: null, me: null, members: [], followedEvents: [], error: null }); return }
    try {
      const d = await getClub()
      setState({ ready: true, club: d.club ?? null, me: d.me ?? null, members: d.members ?? [], followedEvents: d.followedEvents ?? [], error: null })
    } catch (err) {
      setState({ ready: true, club: null, me: null, members: [], followedEvents: [], error: err.message })
    }
  }, [user])

  useEffect(() => { load() }, [load])

  return { ...state, reload: load }
}
