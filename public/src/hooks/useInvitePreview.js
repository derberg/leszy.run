import { useEffect, useState } from 'react'
import { previewInvite } from '../lib/clubs.js'

/**
 * The club behind an invite code, readable without a session.
 * @returns {{ preview: { club: { name: string, slug: string }, state: string, direct: boolean } | null, error: string | null, loading: boolean }}
 */
export default function useInvitePreview(code) {
  const [result, setResult] = useState({ preview: null, error: null, loading: !!code })

  useEffect(() => {
    if (!code) {
      setResult({ preview: null, error: null, loading: false })
      return
    }
    let cancelled = false
    setResult({ preview: null, error: null, loading: true })
    previewInvite(code)
      .then(preview => { if (!cancelled) setResult({ preview, error: null, loading: false }) })
      .catch(err => { if (!cancelled) setResult({ preview: null, error: err.message, loading: false }) })
    return () => { cancelled = true }
  }, [code])

  return result
}
