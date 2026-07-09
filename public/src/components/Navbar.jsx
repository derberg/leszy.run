import { useState, useRef, useEffect, Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import ThemeToggle from './ThemeToggle.jsx'
import useAuth from '../hooks/useAuth.js'
import useNotifications from '../hooks/useNotifications.js'
import useBeta from '../hooks/useBeta.js'
import { signOut } from '../lib/auth.js'

const navLinks = [
  { to: '/', label: 'Start', hash: '' },
  { to: '/#oferta', label: 'Oferta', hash: 'oferta' },
  { to: '/#wydarzenia', label: 'Wydarzenia', hash: 'wydarzenia' },
  { to: '/kalendarz', label: 'Kalendarz', hash: '', dropdown: true },
  { to: '/#kontakt', label: 'Kontakt', hash: 'kontakt' },
]

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef(null)
  const location = useLocation()
  const { user, loading: authLoading } = useAuth()
  const { unseenCount } = useNotifications()
  const beta = useBeta() // accounts UI is dark-launched; hide auth chip when off
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef(null)

  const isActive = (link) => {
    if (link.to === '/kalendarz') return location.pathname === '/kalendarz' || location.pathname.startsWith('/listy')
    if (link.to === '/') return location.pathname === '/' && !location.hash
    return false
  }

  const handleHashClick = (e, hash) => {
    if (location.pathname === '/' && hash) {
      e.preventDefault()
      const el = document.getElementById(hash)
      if (el) el.scrollIntoView({ behavior: 'smooth' })
      setMenuOpen(false)
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    function handleClick(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 h-14 bg-apex-bg/85 backdrop-blur-md border-b border-apex-border" role="navigation" aria-label="Nawigacja główna">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-apex-yellow focus:text-apex-ink focus:px-4 focus:py-2 focus:z-[100]">
        Przejdź do treści
      </a>
      <Link to="/" className="font-display font-extrabold text-[22px] tracking-wider text-apex-text-bright no-underline">
        LESZY<span className="text-apex-yellow">.RUN</span>
      </Link>

      {/* Desktop nav */}
      <div className="hidden md:flex gap-7 items-center">
        {navLinks.map(link => (
          link.dropdown ? (
            <div key={link.to} className="relative" ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen(v => !v)}
                className={`font-sans font-semibold text-sm tracking-wider uppercase transition-colors flex items-center gap-1 ${isActive(link) ? 'text-apex-yellow' : 'text-apex-muted hover:text-apex-text-bright'}`}
              >
                {link.label}
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}>
                  <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              {dropdownOpen && (
                <div className="absolute top-full left-0 mt-2 w-52 bg-apex-bg border border-apex-border shadow-lg">
                  <Link
                    to="/kalendarz"
                    onClick={() => setDropdownOpen(false)}
                    className="block px-4 py-2.5 font-sans text-sm text-apex-text hover:text-apex-yellow hover:bg-apex-surface transition-colors no-underline"
                  >
                    Przeglądaj kalendarz
                  </Link>
                  <Link
                    to="/listy"
                    onClick={() => setDropdownOpen(false)}
                    className="block px-4 py-2.5 font-sans text-sm text-apex-text hover:text-apex-yellow hover:bg-apex-surface transition-colors no-underline border-t border-apex-border"
                  >
                    Lista kategorii
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <Link
              key={link.to}
              to={link.to}
              onClick={(e) => handleHashClick(e, link.hash)}
              className={`font-sans font-semibold text-sm tracking-wider uppercase no-underline transition-colors ${isActive(link) ? 'text-apex-yellow' : 'text-apex-muted hover:text-apex-text-bright'}`}
            >
              {link.label}
            </Link>
          )
        ))}
      </div>

      {/* Desktop CTA + theme toggle */}
      <div className="hidden md:flex items-center gap-3">
        <ThemeToggle />
        {beta && (user ? (
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen(v => !v)}
              className="flex items-center gap-2 font-mono text-xs text-apex-yellow border border-apex-yellow px-3 py-1.5 hover:bg-apex-yellow hover:text-apex-ink transition-all"
            >
              <span className="w-2 h-2 rounded-full bg-apex-yellow inline-block" />
              {user.username || user.email?.split('@')[0]}
              {unseenCount > 0 && (
                <span data-testid="notif-badge" className="ml-1 min-w-[16px] h-4 px-1 inline-flex items-center justify-center bg-apex-yellow text-apex-ink font-mono text-[9px] font-bold leading-none">
                  {unseenCount}
                </span>
              )}
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-44 bg-apex-bg border border-apex-border shadow-lg z-50">
                <Link
                  to="/profil"
                  onClick={() => setUserMenuOpen(false)}
                  className="block px-4 py-2.5 font-sans text-sm text-apex-text hover:text-apex-yellow hover:bg-apex-surface transition-colors no-underline"
                >
                  Mój profil
                </Link>
                <button
                  onClick={async () => {
                    setUserMenuOpen(false)
                    try { await signOut() } finally { window.location.href = '/' }
                  }}
                  className="w-full text-left px-4 py-2.5 font-sans text-sm text-apex-muted hover:text-apex-red hover:bg-apex-surface transition-colors border-t border-apex-border"
                >
                  Wyloguj się
                </button>
              </div>
            )}
          </div>
        ) : authLoading ? (
          /* auth state unknown (first fetch in flight) — reserve space, don't flash "Zaloguj się" */
          <span aria-hidden="true" className="font-mono text-xs border border-transparent px-3 py-1.5 invisible select-none">
            Zaloguj się
          </span>
        ) : (
          <Link
            to="/login"
            className="font-mono text-xs text-apex-muted border border-apex-border px-3 py-1.5 hover:text-apex-yellow hover:border-apex-yellow transition-all no-underline"
          >
            Zaloguj się
          </Link>
        ))}
        <Link
          to="/#kontakt"
          onClick={(e) => handleHashClick(e, 'kontakt')}
          className="font-display font-bold text-[13px] tracking-widest uppercase px-5 py-2 border-2 border-apex-yellow text-apex-yellow no-underline hover:bg-apex-yellow hover:text-apex-ink transition-all"
        >
          Organizujesz bieg?
        </Link>
      </div>

      {/* Mobile auth chip + theme toggle + hamburger */}
      <div className="md:hidden flex items-center gap-3">
        <ThemeToggle />
        {beta && (user ? (
          <Link
            to="/profil"
            className="flex items-center gap-1.5 font-mono text-[11px] text-apex-yellow border border-apex-yellow px-2.5 py-1 hover:bg-apex-yellow hover:text-apex-ink transition-all no-underline"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-apex-yellow inline-block" />
            {user.username || user.email?.split('@')[0]}
            {unseenCount > 0 && (
              <span data-testid="notif-badge" className="ml-1 min-w-[16px] h-4 px-1 inline-flex items-center justify-center bg-apex-yellow text-apex-ink font-mono text-[9px] font-bold leading-none">
                {unseenCount}
              </span>
            )}
          </Link>
        ) : authLoading ? (
          <span aria-hidden="true" className="font-mono text-[11px] border border-transparent px-2.5 py-1 invisible select-none">
            Zaloguj się
          </span>
        ) : (
          <Link
            to="/login"
            className="font-mono text-[11px] text-apex-muted border border-apex-border px-2.5 py-1 hover:text-apex-yellow hover:border-apex-yellow transition-all no-underline"
          >
            Zaloguj się
          </Link>
        ))}
        <button
          className="text-apex-text-bright"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={menuOpen ? 'Zamknij menu' : 'Otwórz menu'}
          aria-expanded={menuOpen}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {menuOpen
              ? <path d="M6 6l12 12M6 18L18 6" />
              : <path d="M3 6h18M3 12h18M3 18h18" />
            }
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="absolute top-14 left-0 right-0 bg-apex-bg/95 backdrop-blur-md border-b border-apex-border flex flex-col p-6 gap-4 md:hidden">
          {navLinks.map(link => (
            link.dropdown ? (
              <Fragment key={link.to}>
                <Link
                  to="/kalendarz"
                  onClick={() => setMenuOpen(false)}
                  className={`font-sans font-semibold text-base tracking-wider uppercase no-underline ${location.pathname === '/kalendarz' ? 'text-apex-yellow' : 'text-apex-muted'}`}
                >
                  Kalendarz
                </Link>
                <Link
                  to="/listy"
                  onClick={() => setMenuOpen(false)}
                  className={`font-sans font-semibold text-base tracking-wider uppercase no-underline ${location.pathname.startsWith('/listy') ? 'text-apex-yellow' : 'text-apex-muted'}`}
                >
                  Lista kategorii
                </Link>
              </Fragment>
            ) : (
              <Link
                key={link.to}
                to={link.to}
                onClick={(e) => { handleHashClick(e, link.hash); setMenuOpen(false) }}
                className={`font-sans font-semibold text-base tracking-wider uppercase no-underline ${isActive(link) ? 'text-apex-yellow' : 'text-apex-muted'}`}
              >
                {link.label}
              </Link>
            )
          ))}
          {user && (
            <button onClick={async () => {
              setMenuOpen(false)
              try { await signOut() } finally { window.location.href = '/' }
            }}
              className="text-left font-sans font-semibold text-base tracking-wider uppercase text-apex-muted">
              Wyloguj się
            </button>
          )}
          <Link
            to="/#kontakt"
            onClick={(e) => { handleHashClick(e, 'kontakt'); setMenuOpen(false) }}
            className="font-display font-bold text-sm tracking-widest uppercase mt-2 px-5 py-3 border-2 border-apex-yellow text-apex-yellow no-underline text-center"
          >
            Organizujesz bieg?
          </Link>
        </div>
      )}
    </nav>
  )
}
