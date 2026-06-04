import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import { requestCode, verifyCode } from '../lib/auth.js'
import useAuth, { clearAuthCache } from '../hooks/useAuth.js'
import { clearFavoritesCache } from '../hooks/useFavorites.js'
import useSeo from '../hooks/useSeo.js'

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-xs tracking-widest uppercase text-apex-muted mb-1.5'

// Only allow internal redirects: must start with a single "/", no "//" (off-site), no "\".
function sanitizeFrom(raw) {
  if (!raw || typeof raw !== 'string') return null
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//') || raw.includes('\\')) return null
  return raw
}

export default function Login() {
  useSeo({ title: 'Logowanie — Leszy.run', path: '/login', noindex: true })

  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const linkEmail = searchParams.get('email')
  const linkCode = searchParams.get('code')
  const fromParam = sanitizeFrom(searchParams.get('from'))
  const hasMagicLink = !!linkEmail && /^\d{6}$/.test(linkCode || '')

  // Where to land after successful auth, in priority order.
  const postAuthPath = (hasUsername) => fromParam || (hasUsername ? '/profil' : '/onboarding')

  const [step, setStep] = useState('email') // 'email' | 'code'
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [submitting, setSubmitting] = useState(hasMagicLink)
  const [error, setError] = useState(null)

  // Already logged in — redirect away
  useEffect(() => {
    if (!loading && user) {
      navigate(postAuthPath(!!user.username), { replace: true })
    }
  }, [user, loading, navigate])

  // Magic link auto-verify — runs when ?email=&code= are present and user is not logged in
  useEffect(() => {
    if (loading || user || !hasMagicLink) return
    ;(async () => {
      try {
        const { hasUsername } = await verifyCode(linkEmail.trim().toLowerCase(), linkCode)
        // Hard redirect so useAuth re-runs and picks up the new session cookie
        window.location.href = postAuthPath(hasUsername)
      } catch (err) {
        setError('Link wygasł lub jest nieprawidłowy. Wpisz kod ręcznie.')
        setEmail(linkEmail)
        setStep('code')
        // Preserve `from` so manual code entry still redirects correctly
        const preserved = {}
        if (fromParam) preserved.from = fromParam
        setSearchParams(preserved, { replace: true })
        setSubmitting(false)
      }
    })()
  }, [loading, user, hasMagicLink, linkEmail, linkCode])

  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await requestCode(email.trim().toLowerCase(), honeypot, fromParam)
      setStep('code')
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCodeSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const { hasUsername } = await verifyCode(email.trim().toLowerCase(), code.trim())
      clearAuthCache()
      clearFavoritesCache()
      navigate(postAuthPath(hasUsername), { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return null

  // Show a "logowanie..." state while the magic link is being verified
  if (hasMagicLink && submitting && !error) {
    return (
      <div className="min-h-screen bg-apex-bg text-apex-text">
        <Navbar />
        <main className="flex items-center justify-center min-h-screen pt-14 px-4">
          <div className="text-center">
            <div className="font-display font-bold text-sm tracking-widest uppercase text-apex-yellow animate-pulse">
              Logowanie…
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="flex items-center justify-center min-h-screen pt-14 px-4">
        <div className="w-full max-w-sm">
          <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-2">
            Zaloguj się
          </h1>
          <p className="font-sans text-apex-muted text-sm mb-8">
            {step === 'email'
              ? 'Podaj email — wyślemy Ci kod logowania.'
              : `Podaj 6-cyfrowy kod wysłany na ${email}.`}
          </p>

          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-5">
              {/* Honeypot — hidden from humans, catches bots */}
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <input type="text" name="website" tabIndex={-1} autoComplete="off"
                  value={honeypot} onChange={e => setHoneypot(e.target.value)} />
              </div>
              <div>
                <label htmlFor="email" className={labelClass}>Email</label>
                <input id="email" type="email" value={email}
                  onChange={e => setEmail(e.target.value)}
                  required autoFocus className={inputClass} placeholder="ty@przyklad.pl" />
              </div>
              {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
              <button type="submit" disabled={submitting}
                className="w-full font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40">
                {submitting ? 'Wysyłanie…' : 'Wyślij kod'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-5">
              <div>
                <label htmlFor="code" className={labelClass}>Kod (6 cyfr)</label>
                <input id="code" type="text" inputMode="numeric" pattern="\d{6}"
                  value={code} onChange={e => setCode(e.target.value)}
                  required autoFocus maxLength={6} className={inputClass} placeholder="123456" />
              </div>
              {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
              <button type="submit" disabled={submitting}
                className="w-full font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40">
                {submitting ? 'Weryfikacja…' : 'Zaloguj się'}
              </button>
              <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null) }}
                className="w-full font-mono text-xs text-apex-muted hover:text-apex-text transition-colors py-2">
                ← Zmień email
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
