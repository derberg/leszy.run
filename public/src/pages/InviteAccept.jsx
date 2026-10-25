import { useState } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import useAuth from '../hooks/useAuth.js'
import useSeo from '../hooks/useSeo.js'
import { acceptInvite } from '../lib/clubs.js'
import MembershipVisibilityChoice from '../components/MembershipVisibilityChoice.jsx'
import useInvitePreview from '../hooks/useInvitePreview.js'

const primaryBtnClass = 'font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'

// /klub/:slug/dolacz?kod=CODE — the SPA-owned invite-accept route. Everyone
// first sees which club the invite is for (preview-invite needs no session).
// A logged-out visitor gets a login button that carries this path in ?from=,
// so Login (and onboarding, for a new account) lands them back here; a
// logged-in one confirms before the join actually happens.
const DEAD_INVITE = {
  revoked: 'Zaproszenie zostało cofnięte.',
  expired: 'Zaproszenie wygasło.',
  exhausted: 'Zaproszenie zostało już wykorzystane.',
}

export default function InviteAccept() {
  useSeo({ title: 'Dołącz do klubu — Leszy.run', noindex: true })

  const { slug } = useParams()
  const [searchParams] = useSearchParams()
  const kod = searchParams.get('kod')
  const { user, loading: authLoading } = useAuth()
  const { preview, errorStatus: previewStatus, loading: previewLoading } = useInvitePreview(kod)
  const loading = authLoading || previewLoading
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)
  const [hiddenPublic, setHiddenPublic] = useState(false)

  const returnPath = `/klub/${slug}/dolacz${kod ? `?kod=${encodeURIComponent(kod)}` : ''}`

  async function confirm() {
    if (!kod) {
      setError('Brak kodu zaproszenia w linku.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await acceptInvite({ code: kod, hidden_public: hiddenPublic })
      setDone(true)
      // Prefer the canonical slug the API returns (covers a mid-flight slug
      // rename) and fall back to the invite URL's :slug param.
      navigate(`/klub/${result?.club?.slug || slug}/panel`, { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const clubName = preview?.club?.name
  // Only a 404 or a dead state settles it. A throttled or failed preview leaves
  // the old flow in place: no club name, and accept-invite has the last word.
  const deadReason = previewStatus === 404
    ? 'Nieprawidłowy kod zaproszenia.'
    : (preview && DEAD_INVITE[preview.state])

  let body
  if (loading) {
    body = <p className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</p>
  } else if (kod && deadReason) {
    body = (
      <p className="font-sans text-sm text-apex-red" data-testid="invite-error">
        {deadReason} Poproś osobę, która Cię zaprosiła, o nowy link.
      </p>
    )
  } else if (!user) {
    body = (
      <>
        <p className="font-sans text-sm text-apex-text mb-5">
          {kod ? 'Zaloguj się albo załóż konto, aby dołączyć do klubu.' : 'Zaloguj się, aby dołączyć do klubu.'}
        </p>
        <Link
          data-testid="invite-login"
          to={`/login?from=${encodeURIComponent(returnPath)}`}
          className={`inline-block ${primaryBtnClass}`}
        >
          Zaloguj się
        </Link>
      </>
    )
  } else if (!user.username) {
    // A session with no username has never accepted the regulamin; onboarding
    // does that and then forwards back here.
    body = (
      <Link
        to={`/onboarding?from=${encodeURIComponent(returnPath)}`}
        className={`inline-block ${primaryBtnClass}`}
      >
        Dokończ zakładanie konta
      </Link>
    )
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
          {clubName ? <>Dołączyć do klubu <strong className="text-apex-text-bright">{clubName}</strong>?</> : 'Dołączyć do klubu?'}
        </p>
        <div className="text-left mb-5">
          <MembershipVisibilityChoice value={hiddenPublic} onChange={setHiddenPublic} />
        </div>
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
          {clubName && (
            <p data-testid="invite-club-name" className="font-display font-extrabold text-3xl text-apex-yellow uppercase tracking-wider mb-6 break-words">
              {clubName}
            </p>
          )}
          {body}
        </div>
      </main>
    </div>
  )
}
