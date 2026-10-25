import { useEffect, useState } from 'react'
import { previewInvite } from '../lib/clubs.js'

/**
 * The club behind an invite code, readable without a session.
 * `errorStatus` 404 means the code exists nowhere. Any other failure (a 429,
 * a network error) says nothing about the invite, so callers must not treat
 * it as a dead one.
 * @returns {{ preview: { club: { name: string }, state: string } | null, errorStatus: number | null, loading: boolean }}
 */
export default function useInvitePreview(code) {
  const [result, setResult] = useState({ preview: null, errorStatus: null, loading: !!code })

  useEffect(() => {
    if (!code) {
      setResult({ preview: null, errorStatus: null, loading: false })
      return
    }
    let cancelled = false
    setResult({ preview: null, errorStatus: null, loading: true })
    previewInvite(code)
      .then(preview => { if (!cancelled) setResult({ preview, errorStatus: null, loading: false }) })
      .catch(err => { if (!cancelled) setResult({ preview: null, errorStatus: err.status ?? 0, loading: false }) })
    return () => { cancelled = true }
  }, [code])

  return result
}
