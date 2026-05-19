import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import useAuth from '../hooks/useAuth.js'
import { signInWithEmail, verifyOtp } from '../lib/auth.js'
import { supabase } from '../lib/supabase.js'
import useSeo from '../hooks/useSeo.js'

export default function Login() {
  useSeo({ title: 'Zaloguj się — Leszy.run', path: '/login', noindex: true })

  const { user, loading } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState('email')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (loading || !user) return
    // Check if profile exists to decide where to redirect
    supabase.from('profiles').select('id').eq('id', user.id).single().then(({ data }) => {
      navigate(data ? '/profil' : '/onboarding', { replace: true })
    })
  }, [user, loading, navigate])

  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signInWithEmail(email)
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
      await verifyOtp(email, code)
    } catch (err) {
      setError('Nieprawidłowy kod. Sprawdź email lub spróbuj ponownie.')
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-3 px-4 outline-none focus:border-apex-yellow-dim transition-colors'
  const btnClass = 'w-full font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="flex items-center justify-center min-h-screen pt-14 px-4">
        <div className="w-full max-w-sm">
          <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-2">
            {step === 'email' ? 'Zaloguj się' : 'Wpisz kod'}
          </h1>
          <p className="font-sans text-apex-muted text-sm mb-8">
            {step === 'email'
              ? 'Wyślemy Ci link i kod jednorazowy na podany adres email.'
              : `Wysłaliśmy kod na ${email}. Sprawdź też link w emailu — kliknięcie zaloguje Cię od razu.`}
          </p>

          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div>
                <label className="block font-display font-bold text-xs tracking-widest uppercase text-apex-muted mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  aria-label="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  placeholder="twoj@email.pl"
                  className={inputClass}
                />
              </div>
              {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
              <button type="submit" disabled={submitting || !email} className={btnClass}>
                {submitting ? 'Wysyłanie…' : 'Wyślij kod'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-4">
              <div>
                <label className="block font-display font-bold text-xs tracking-widest uppercase text-apex-muted mb-1.5">
                  Kod jednorazowy (6 cyfr)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  autoFocus
                  placeholder="123456"
                  className={`${inputClass} tracking-[0.5em] text-center text-lg`}
                />
              </div>
              {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
              <button type="submit" disabled={submitting || code.length !== 6} className={btnClass}>
                {submitting ? 'Sprawdzanie…' : 'Zaloguj się'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('email'); setCode(''); setError(null) }}
                className="w-full font-sans text-xs text-apex-muted hover:text-apex-text transition-colors py-2"
              >
                Zmień adres email
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
