import { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import useAuth from '../hooks/useAuth.js'
import useSeo from '../hooks/useSeo.js'
import { acceptInvite } from '../lib/clubs.js'

const primaryBtnClass = 'font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'

// /klub/:slug/dolacz?kod=CODE — the SPA-owned invite-accept route. The bare
// /klub/:slug is an SSR rewrite (render-club) and is untouched by this route.
// Logged-out visitors are bounced to /login preserving the full path (Login
// already honors ?from= and lands them back here post-auth); logged-in
// visitors get a confirm screen before the join actually happens.
export default function InviteAccept() {
  useSeo({ title: 'Dołącz do klubu — Leszy.run', noindex: true })

  const { slug } = useParams()
  const [searchParams] = useSearchParams()
  const kod = searchParams.get('kod')
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const returnPath = `/klub/${slug}/dolacz${kod ? `?kod=${encodeURIComponent(kod)}` : ''}`

  // Logged-out visitors are bounced to /login, preserving the invite link via
  // ?from= so Login lands them right back here post-auth.
  useEffect(() => {
    if (!loading && !user) {
      navigate(`/login?from=${encodeURIComponent(returnPath)}`, { replace: true })
    }
  }, [loading, user, returnPath, navigate])

  async function confirm() {
    if (!kod) {
      setError('Brak kodu zaproszenia w linku.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await acceptInvite({ code: kod })
      setDone(true)
      navigate('/profil/klub', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  let body
  if (loading) {
    body = <p className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</p>
  } else if (!user) {
    body = <p className="font-mono text-sm text-apex-muted animate-pulse">Zaloguj się, aby dołączyć do klubu…</p>
  } else if (!kod) {
    body = (
      <>
        <p className="font-sans text-sm text-apex-red mb-3" data-testid="invite-error">
          Brak kodu zaproszenia w linku.
        </p>
        <Link to={`/klub/${slug}`} className="font-mono text-xs text-apex-yellow hover:underline">
          Zobacz publiczną stronę klubu
        </Link>
      </>
    )
  } else if (error) {
    body = (
      <>
        <p className="font-sans text-sm text-apex-red mb-3" data-testid="invite-error">{error}</p>
        <Link to={`/klub/${slug}`} className="font-mono text-xs text-apex-yellow hover:underline">
          Zobacz publiczną stronę klubu
        </Link>
      </>
    )
  } else if (done) {
    body = <p className="font-sans text-sm text-apex-text">Dołączono do klubu.</p>
  } else {
    body = (
      <>
        <p className="font-sans text-sm text-apex-text mb-5">
          Dołączyć do klubu?
        </p>
        <button
          data-testid="accept-invite-confirm"
          onClick={confirm}
          disabled={busy}
          className={primaryBtnClass}
        >
          {busy ? 'Dołączanie…' : 'Dołącz do klubu'}
        </button>
      </>
    )
  }

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="flex items-center justify-center min-h-screen pt-14 px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="font-display font-extrabold text-2xl text-apex-text-bright uppercase tracking-wider mb-4">
            Zaproszenie do klubu
          </h1>
          {body}
        </div>
      </main>
    </div>
  )
}
