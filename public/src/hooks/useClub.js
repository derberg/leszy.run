import { useState, useEffect, useCallback } from 'react'
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

  // Param-only navigation (e.g. slug rename) must not render the previous
  // club's data — adjust during render (React bails out and re-renders with
  // ready:false BEFORE ClubLayout's canonical-slug check can see stale data);
  // an effect would run one render too late.
  const [prevSlug, setPrevSlug] = useState(slug)
  if (slug !== prevSlug) {
    setPrevSlug(slug)
    setState((s) => ({ ...s, ready: false }))
  }

  const load = useCallback(async () => {
    if (!user) { setState({ ready: true, club: null, me: null, members: [], followedEvents: [], error: null }); return }
    try {
      const d = await getClub(slug ? { slug } : {})
      setState({ ready: true, club: d.club ?? null, me: d.me ?? null, members: d.members ?? [], followedEvents: d.followedEvents ?? [], error: null })
    } catch (err) {
      setState({ ready: true, club: null, me: null, members: [], followedEvents: [], error: err.message })
    }
  }, [user, slug])

  useEffect(() => { load() }, [load])

  return { ...state, reload: load }
}
