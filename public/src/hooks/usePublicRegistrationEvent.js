import { useEffect, useState } from 'react'

// The public registration event page's data: one GET /api/event?slug= (the
// CDN-cached snapshot, never a per-viewer Supabase query). Kept per slug for
// the page's lifetime, so moving between RA1, the course and the form does not
// fetch again; a full reload reads the snapshot afresh.
//
// → { status: 'loading' | 'ok' | 'missing', raw }
// 'missing' covers 404 (no published registration event under that slug),
// 400 (not a registration slug at all) and errors: the caller then shows the
// ordinary event page, which is what every older event is.
const cache = new Map()

async function load(slug) {
  try {
    const res = await fetch(`/api/event?slug=${encodeURIComponent(slug)}`)
    if (!res.ok) return { status: 'missing', raw: null }
    return { status: 'ok', raw: await res.json() }
  } catch {
    return { status: 'missing', raw: null }
  }
}

/** Forget a slug's snapshot (after registering, so RA1 counts the new runner on the next visit). */
export function forgetPublicRegistrationEvent(slug) {
  cache.delete(slug)
}

export default function usePublicRegistrationEvent(slug) {
  const [state, setState] = useState(() => {
    const hit = cache.get(slug)
    return hit && !(hit instanceof Promise) ? hit : { status: 'loading', raw: null }
  })

  useEffect(() => {
    if (!slug) return undefined
    let active = true
    const hit = cache.get(slug)
    if (hit && !(hit instanceof Promise)) {
      setState(hit)
      return undefined
    }
    const pending = hit ?? load(slug).then((r) => {
      // A failure is not remembered: the next page view tries again.
      if (r.status === 'ok') cache.set(slug, r)
      else cache.delete(slug)
      return r
    })
    cache.set(slug, pending)
    pending.then((r) => { if (active) setState(r) })
    return () => { active = false }
  }, [slug])

  return state
}
