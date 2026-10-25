import { useState, useEffect } from 'react'
import { getClub } from '../lib/clubs.js'
import { readCache, writeCache, isFresh, USER_CACHE_KEYS } from '../lib/clientCache.js'

const CACHE_KEY = USER_CACHE_KEYS[2]
const TTL_MS = 5 * 60 * 1000 // 5 min

/**
 * How many upcoming starts the clubmates follow, for the count next to
 * "Starty klubowiczów" in the account menu. get-club returns the whole club
 * panel, so it is asked only while the menu is open (`enabled`) and the count
 * is kept for five minutes. Only the number is stored, never whose starts.
 * @param {string|null|undefined} clubId the user's club, from auth-me
 * @param {boolean} enabled
 * @returns {number|null} null until known
 */
export default function useClubStarts(clubId, enabled) {
  const [count, setCount] = useState(() => cachedCount(clubId))

  useEffect(() => {
    if (!enabled || !clubId) return
    const cached = cachedCount(clubId)
    if (cached !== null) { setCount(cached); return }
    let active = true
    getClub({})
      .then((d) => {
        // get-club answers for the profile's club, which is the one auth-me
        // named; a mismatch means the club changed since auth-me was cached.
        if (!d?.club || d.club.id !== clubId) return
        const n = (d.followedEvents ?? []).filter((f) => f.event?.status !== 'cancelled').length
        writeCache(CACHE_KEY, { clubId, count: n })
        if (active) setCount(n)
      })
      .catch(() => { /* the menu works without the count */ })
    return () => { active = false }
  }, [clubId, enabled])

  return clubId ? count : null
}

function cachedCount(clubId) {
  const entry = readCache(CACHE_KEY)
  if (!clubId || !isFresh(entry, TTL_MS) || entry.value?.clubId !== clubId) return null
  return entry.value.count
}
