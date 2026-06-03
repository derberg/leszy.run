import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import AuthGuard from '../components/AuthGuard.jsx'
import Navbar from '../components/Navbar.jsx'
import useAuth from '../hooks/useAuth.js'
import { callFunction } from '../lib/auth.js'
import useSeo from '../hooks/useSeo.js'
import { supabase } from '../lib/supabase.js'

function OnboardingForm() {
  useSeo({ title: 'Ustaw profil — Leszy.run', path: '/onboarding', noindex: true })

  const { user } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [club, setClub] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [usernameStatus, setUsernameStatus] = useState('idle') // idle | checking | available | taken
  const usernameRef = useRef(username)
  usernameRef.current = username

  useEffect(() => {
    if (user?.username) navigate('/profil', { replace: true })
  }, [user, navigate])

  useEffect(() => {
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      setUsernameStatus('idle')
      return
    }
    setUsernameStatus('checking')
    const checked = username
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('is_username_available', { u: checked })
      if (usernameRef.current !== checked) return // stale response — input changed meanwhile
      if (error) { setUsernameStatus('idle'); return }
      setUsernameStatus(data ? 'available' : 'taken')
    }, 400)
    return () => clearTimeout(t)
  }, [username])

  async function handleSubmit(e) {
    e.preventDefault()
    if (username.length < 3) {
      setError('Nazwa użytkownika musi mieć co najmniej 3 znaki.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await callFunction('update-profile', {
        username: username.toLowerCase(),
        ...(displayName ? { display_name: displayName } : {}),
        ...(club ? { club } : {}),
      })
      navigate('/profil', { replace: true })
    } catch (err) {
      setError(/already taken/i.test(err.message) ? 'Ta nazwa jest już zajęta.' : err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
  const labelClass = 'block font-display font-bold text-xs tracking-widest uppercase text-apex-muted mb-1.5'

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="flex items-center justify-center min-h-screen pt-14 px-4">
        <div className="w-full max-w-sm">
          <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-2">
            Ustaw profil
          </h1>
          <p className="font-sans text-apex-muted text-sm mb-8">
            Wybierz unikalną nazwę użytkownika. Reszta jest opcjonalna.
          </p>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="username" className={labelClass}>Nazwa użytkownika *</label>
              <div className="flex items-center border border-apex-border focus-within:border-apex-yellow-dim transition-colors bg-apex-surface">
                <span className="pl-3.5 text-apex-muted font-mono text-sm">@</span>
                <input
                  id="username"
                  aria-label="nazwa użytkownika"
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  required
                  maxLength={30}
                  placeholder="twoja_nazwa"
                  className="flex-1 bg-transparent text-apex-text-bright font-mono text-sm font-medium py-2.5 px-2 outline-none"
                />
              </div>
              <div className="flex items-center justify-between mt-1">
                <p className="font-sans text-xs text-apex-muted">3–30 znaków: litery, cyfry, podkreślenie</p>
                {usernameStatus === 'checking' && (
                  <span className="font-mono text-xs text-apex-muted animate-pulse">sprawdzam…</span>
                )}
                {usernameStatus === 'available' && (
                  <span className="font-mono text-xs text-apex-yellow">✓ dostępna</span>
                )}
                {usernameStatus === 'taken' && (
                  <span className="font-mono text-xs text-apex-red">✗ zajęta</span>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="displayName" className={labelClass}>Imię i nazwisko (opcjonalne)</label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Piotr Kowalski"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="club" className={labelClass}>Klub / stowarzyszenie (opcjonalne)</label>
              <input
                id="club"
                type="text"
                value={club}
                onChange={e => setClub(e.target.value)}
                placeholder="Klub Biegacza Kraków"
                className={inputClass}
              />
            </div>
            {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Zapisywanie…' : 'Zapisz i przejdź dalej'}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}

export default function Onboarding() {
  return (
    <AuthGuard>
      <OnboardingForm />
    </AuthGuard>
  )
}
