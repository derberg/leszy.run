import { Navigate, NavLink, Outlet, useParams } from 'react-router-dom'
import Navbar from '../../components/Navbar.jsx'
import AuthGuard from '../../components/AuthGuard.jsx'
import useClub from '../../hooks/useClub.js'
import { KlubContext } from './context.js'

// Slug-scoped club area shell: /klub/:slug/{panel,czlonkowie,zaproszenia,ustawienia}.
// The bare /klub/:slug is the static public page served by Vercel — this layout
// only owns the sub-paths (the index route redirects to panel for client-side
// navigations that land on the bare path). Guards here are UX only; the edge
// functions are the authority.
const TABS = [
  { to: 'panel', label: 'Panel', manage: false },
  { to: 'czlonkowie', label: 'Członkowie', manage: false },
  { to: 'zaproszenia', label: 'Zaproszenia', manage: true },
  { to: 'ustawienia', label: 'Ustawienia', manage: true },
]

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main data-testid="klub-page" className="pt-20 pb-16 px-4 md:px-8 max-w-5xl mx-auto">
        {children}
      </main>
    </div>
  )
}

function ClubShell() {
  const { slug } = useParams()
  const { ready, club, me, members, followedEvents, error, reload } = useClub({ slug })

  if (!ready) {
    return <Shell><p className="font-mono text-sm text-apex-muted animate-pulse py-8">Ładowanie…</p></Shell>
  }
  // Not an active member, club gone, or fetch failed — nothing to show here.
  if (error || !club || !me) return <Navigate to="/profil/klub" replace />
  // Old slug resolved via history — normalize the URL to the canonical slug.
  if (club.slug && club.slug !== slug) return <Navigate to={`/klub/${club.slug}/panel`} replace />

  const canManage = me.role === 'owner' || me.role === 'admin'
  const isOwner = me.role === 'owner'
  const tabs = TABS.filter((t) => !t.manage || canManage)

  const navItemClass = ({ isActive }) =>
    `whitespace-nowrap font-display font-bold text-sm uppercase tracking-wide px-3 py-2.5 no-underline transition-all border-b-2 ${
      isActive
        ? 'text-apex-yellow border-apex-yellow bg-apex-surface/40'
        : 'text-apex-muted border-transparent hover:text-apex-text-bright hover:border-apex-border'
    }`

  return (
    <Shell>
      <header className="border-b border-apex-border pb-5 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          {club.logo_url ? (
            <div className="w-12 h-12 flex-shrink-0 border-2 border-apex-yellow bg-apex-surface overflow-hidden">
              <img src={club.logo_url} alt={`Logo ${club.name}`} className="w-full h-full object-cover" />
            </div>
          ) : (
            <div className="w-12 h-12 flex-shrink-0 bg-apex-surface border-2 border-apex-yellow flex items-center justify-center font-display font-bold text-xl text-apex-yellow">
              {club.name?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-display font-bold text-lg text-apex-yellow truncate">{club.name}</div>
            {/* Plain <a>: the bare public page is a static file — client-side
                routing would land in the SPA instead of Vercel's HTML. */}
            {club.is_public && (
              <a href={`/klub/${club.slug}`} target="_blank" rel="noopener"
                className="font-mono text-[10px] text-apex-muted hover:text-apex-yellow">
                leszy.run/klub/{club.slug} ↗
              </a>
            )}
          </div>
        </div>
      </header>

      <nav data-testid="klub-nav" aria-label="Sekcje klubu"
        className="flex gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 border-b border-apex-border mb-6">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={navItemClass}>{t.label}</NavLink>
        ))}
      </nav>

      <KlubContext.Provider value={{ club, me, members, followedEvents, reload, canManage, isOwner }}>
        <Outlet />
      </KlubContext.Provider>
    </Shell>
  )
}

export default function ClubLayout() {
  return (
    <AuthGuard>
      <ClubShell />
    </AuthGuard>
  )
}
