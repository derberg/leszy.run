import { useState } from 'react'

// Dark-launch flag for the accounts / community product (login, profile, stars,
// notifications, report/feedback, add-event). OFF by default so production looks
// unchanged after merge. Flip per-browser with `?beta=1` (persisted to
// localStorage so it survives navigation + full reloads); `?beta=0` clears it.
//
// This is a VISIBILITY switch, not a security boundary — anyone can set it, and
// the edge functions / routes remain publicly reachable. It only controls what
// the UI advertises until the feature is launched for everyone.
const KEY = 'leszy.beta'

export function isBeta() {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.has('beta')) {
      const on = params.get('beta') !== '0'
      if (on) localStorage.setItem(KEY, '1')
      else localStorage.removeItem(KEY)
      return on
    }
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false // SSR / static generation / storage disabled → treat as off
  }
}

export default function useBeta() {
  // Read once on mount; the flag only changes via a full navigation with ?beta=.
  const [beta] = useState(isBeta)
  return beta
}
