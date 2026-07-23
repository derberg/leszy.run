import { useState, useEffect, useCallback, useRef } from 'react'
import useAuth from './useAuth.js'
import { getClub } from '../lib/clubs.js'

// Fetches a club (by slug, or the caller's active club if no slug).
// Component-local (not a module-level cache like useFavorites).
//
// get-club returns `{ data: { club: null } }` (200) for callers who are not
// an active member of any club — that's an expected "no club yet" state, not
// an error. Anything else thrown (network failure, 401, etc.) is surfaced via
// `error` so the section can show a real failure message.
export default function useClub({ slug = null } = {}) {
  const { user } = useAuth()
  const [state, setState] = useState({ ready: false, club: null, me: null, members: [], followedEvents: [], error: null })
  const lastSlugRef = useRef(slug)

  const load = useCallback(async () => {
    if (!user) { setState({ ready: true, club: null, me: null, members: [], followedEvents: [], error: null }); return }
    try {
      const d = await getClub(slug ? { slug } : {})
      setState({ ready: true, club: d.club ?? null, me: d.me ?? null, members: d.members ?? [], followedEvents: d.followedEvents ?? [], error: null })
    } catch (err) {
      setState({ ready: true, club: null, me: null, members: [], followedEvents: [], error: err.message })
    }
  }, [user, slug])

  useEffect(() => {
    // Param-only navigation (e.g. slug rename) must not render the previous
    // club's data — drop to loading until the refetch for the new slug lands,
    // or ClubLayout's canonical-slug check would redirect off a stale club.
    if (lastSlugRef.current !== slug) {
      lastSlugRef.current = slug
      setState((s) => ({ ...s, ready: false }))
    }
    load()
  }, [load, slug])

  return { ...state, reload: load }
}
