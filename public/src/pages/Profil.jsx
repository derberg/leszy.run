import { useState, useEffect, Suspense } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import AuthGuard from '../components/AuthGuard.jsx'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useAuth from '../hooks/useAuth.js'
import { callFunction } from '../lib/auth.js'
import { ProfilContext } from './profil/context.js'

// Content sections shown in the profile nav (rail on desktop, tab strip on mobile).
// Settings is reached via the gear icon in the header, not a tab — it is a utility,
// not a browse destination. Future sections (Wyniki, Osiągnięcia) slot in here:
//   { to: '/profil/wyniki', label: 'Wyniki' },
//   { to: '/profil/osiagniecia', label: 'Osiągnięcia' },
const SECTIONS = [
  { to: '/profil/obserwowane', label: 'Obserwowane' },
  { to: '/profil/zgloszenia', label: 'Zgłoszenia' },
]

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function ProfilLayout() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [badges, setBadges] = useState([])
  const [reports, setReports] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    if (!user) return
    setLoadError(null)
    callFunction('get-profile-data', {})
      .then(({ profile, badges, reports, submissions }) => {
        setProfile(profile)
        setBadges(badges)
        setReports(reports)
        setSubmissions(submissions)
      })
      .catch((err) => {
        console.error('Profile data fetch failed:', err)
        setLoadError('Nie udało się wczytać profilu. Spróbuj odświeżyć stronę.')
      })
      .finally(() => setLoading(false))
  }, [user])

  async function handleSave(field, value) {
    try {
      const updated = await callFunction('update-profile', { [field]: value })
      setProfile(updated.data)
    } catch (err) {
      console.error('Profile update failed:', err)
    }
  }

  async function handleClubSave(draft) {
    try {
      const payload = draft.clubId
        ? { club_id: draft.clubId }
        : { club: draft.name.trim() }   // empty string clears
      const updated = await callFunction('update-profile', payload)
      setProfile(updated.data)
    } catch (err) {
      console.error('Club update failed:', err)
      throw err
    }
  }

  const shell = (children) => (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      {children}
      <Footer />
    </div>
  )

  if (loading) {
    return shell(
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</span>
      </div>
    )
  }

  if (loadError) {
    return shell(
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="font-mono text-sm text-apex-red">{loadError}</p>
      </div>
    )
  }

  const navItemClass = ({ isActive }) =>
    `whitespace-nowrap font-display font-bold text-sm uppercase tracking-wide px-3 py-2.5 no-underline transition-all border-b-2 md:border-b-0 md:border-l-2 ${
      isActive
        ? 'text-apex-yellow border-apex-yellow bg-apex-surface/40'
        : 'text-apex-muted border-transparent hover:text-apex-text-bright hover:border-apex-border'
    }`

  return (
    <ProfilContext.Provider value={{ profile, badges, reports, submissions, handleSave, handleClubSave }}>
      {shell(
        <main data-testid="profil-page" className="pt-20 pb-16 px-4 md:px-8 max-w-5xl mx-auto">
          {/* Persistent profile header */}
          <header className="border-b border-apex-border pb-5 mb-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 flex-shrink-0 bg-apex-surface border-2 border-apex-yellow flex items-center justify-center font-display font-bold text-xl text-apex-yellow">
                  {profile?.username?.[0]?.toUpperCase() || '?'}
                </div>
                <div className="min-w-0">
                  <div className="font-display font-bold text-lg text-apex-yellow truncate">@{profile?.username}</div>
                  {profile?.club && (
                    <div className="text-[10px] font-mono text-apex-muted truncate">{profile.club}</div>
                  )}
                </div>
              </div>
              <NavLink
                to="/profil/ustawienia"
                data-testid="nav-ustawienia"
                aria-label="Ustawienia"
                title="Ustawienia"
                className={({ isActive }) =>
                  `flex-shrink-0 p-2 border transition-all ${
                    isActive
                      ? 'border-apex-yellow text-apex-yellow'
                      : 'border-apex-border text-apex-muted hover:text-apex-yellow hover:border-apex-yellow'
                  }`
                }
              >
                <GearIcon />
              </NavLink>
            </div>

            {badges.length > 0 && (
              <div data-testid="badges-section" className="flex flex-wrap gap-1.5 mt-4">
                {badges.map(b => {
                  const def = b.badge_definitions
                  const label = profile?.gender === 'F' && def?.name_female ? def.name_female : def?.name
                  return (
                    <span key={b.id} title={def?.description} className="text-[10px] font-mono border border-apex-border px-1.5 py-0.5 text-apex-yellow">
                      {def?.icon} {label}
                    </span>
                  )
                })}
              </div>
            )}
          </header>

          <div className="flex flex-col md:flex-row gap-6 md:gap-8">
            {/* Section nav: horizontal strip on mobile, left rail on desktop */}
            <nav
              data-testid="profil-nav"
              aria-label="Sekcje profilu"
              className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-4 px-4 md:mx-0 md:px-0 md:w-44 md:flex-shrink-0 border-b border-apex-border md:border-b-0"
            >
              {SECTIONS.map(s => (
                <NavLink key={s.to} to={s.to} className={navItemClass}>
                  {s.label}
                </NavLink>
              ))}
            </nav>

            {/* Active section */}
            <div className="flex-1 min-w-0">
              <Suspense fallback={<div className="font-mono text-sm text-apex-muted animate-pulse py-8">Ładowanie…</div>}>
                <Outlet />
              </Suspense>
            </div>
          </div>
        </main>
      )}
    </ProfilContext.Provider>
  )
}

export default function Profil() {
  return (
    <AuthGuard>
      <ProfilLayout />
    </AuthGuard>
  )
}
