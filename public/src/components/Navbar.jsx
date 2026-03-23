import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

const navLinks = [
  { to: '/', label: 'Start', hash: '' },
  { to: '/#oferta', label: 'Oferta', hash: 'oferta' },
  { to: '/#wydarzenia', label: 'Wydarzenia', hash: 'wydarzenia' },
  { to: '/kalendarz', label: 'Kalendarz', hash: '' },
  { to: '/#kontakt', label: 'Kontakt', hash: 'kontakt' },
]

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  const isActive = (link) => {
    if (link.to === '/kalendarz') return location.pathname === '/kalendarz'
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

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 h-14 bg-apex-bg/85 backdrop-blur-md border-b border-apex-border" role="navigation" aria-label="Nawigacja glowna">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-apex-yellow focus:text-apex-bg focus:px-4 focus:py-2 focus:z-[100]">
        Przejdz do tresci
      </a>
      <Link to="/" className="font-display font-extrabold text-[22px] tracking-wider text-apex-text-bright no-underline">
        LESZY<span className="text-apex-yellow">.RUN</span>
      </Link>

      {/* Desktop nav */}
      <div className="hidden md:flex gap-7 items-center">
        {navLinks.map(link => (
          <Link
            key={link.to}
            to={link.to}
            onClick={(e) => handleHashClick(e, link.hash)}
            className={`font-sans font-semibold text-sm tracking-wider uppercase no-underline transition-colors ${isActive(link) ? 'text-apex-yellow' : 'text-apex-muted hover:text-apex-text-bright'}`}
          >
            {link.label}
          </Link>
        ))}
      </div>

      {/* Desktop CTA */}
      <Link
        to="/#kontakt"
        onClick={(e) => handleHashClick(e, 'kontakt')}
        className="hidden md:block font-display font-bold text-[13px] tracking-widest uppercase px-5 py-2 border-2 border-apex-yellow text-apex-yellow no-underline hover:bg-apex-yellow hover:text-apex-bg transition-all"
      >
        Organizujesz bieg?
      </Link>

      {/* Mobile hamburger */}
      <button
        className="md:hidden text-apex-text-bright"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={menuOpen ? 'Zamknij menu' : 'Otworz menu'}
        aria-expanded={menuOpen}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {menuOpen
            ? <path d="M6 6l12 12M6 18L18 6" />
            : <path d="M3 6h18M3 12h18M3 18h18" />
          }
        </svg>
      </button>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="absolute top-14 left-0 right-0 bg-apex-bg/95 backdrop-blur-md border-b border-apex-border flex flex-col p-6 gap-4 md:hidden">
          {navLinks.map(link => (
            <Link
              key={link.to}
              to={link.to}
              onClick={(e) => { handleHashClick(e, link.hash); setMenuOpen(false) }}
              className={`font-sans font-semibold text-base tracking-wider uppercase no-underline ${isActive(link) ? 'text-apex-yellow' : 'text-apex-muted'}`}
            >
              {link.label}
            </Link>
          ))}
          <Link
            to="/#kontakt"
            onClick={(e) => { handleHashClick(e, 'kontakt'); setMenuOpen(false) }}
            className="font-display font-bold text-sm tracking-widest uppercase px-5 py-3 border-2 border-apex-yellow text-apex-yellow no-underline text-center mt-2"
          >
            Organizujesz bieg?
          </Link>
        </div>
      )}
    </nav>
  )
}
