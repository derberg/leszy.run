# Leszy.run Landing Page, Kalendarz & Data Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a marketing landing page, a national race calendar aggregator, and a scraping pipeline for leszy.run.

**Architecture:** Three phases built sequentially. Phase 1 (landing page) lives entirely in the `public/` React app. Phase 2 (kalendarz) adds a new page + Supabase table. Phase 3 (data pipeline) adds scrapers + admin review UI to the backend and frontend admin app. All calendar data lives in Supabase only (no local DB).

**Tech Stack:** React 19, Vite 6, Tailwind v4, Supabase client, Leaflet.js, cheerio, node-cron, Brave Search API

**Spec:** `docs/superpowers/specs/2026-03-23-leszy-run-landing-kalendarz-pipeline-design.md`

---

## File Map

### Phase 1: Landing Page
| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `public/src/pages/Landing.jsx` | Landing page with all 7 sections |
| Create | `public/src/components/Navbar.jsx` | Fixed navbar shared across pages |
| Create | `public/src/components/Footer.jsx` | Footer shared across pages |
| Modify | `public/src/App.jsx` | Add `/` route, `/kalendarz` route |
| Modify | `public/src/app.css` | Fix contrast tokens, add hero animations |
| Modify | `public/index.html` | Update `<title>` to "Leszy.run" |

### Phase 2: Kalendarz
| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `public/src/pages/Kalendarz.jsx` | Kalendarz page with filters + list/map |
| Create | `public/src/components/FilterBar.jsx` | Sticky filter bar with all selects |
| Create | `public/src/components/EventRow.jsx` | Single event row in list view |
| Create | `public/src/components/MapView.jsx` | Leaflet map with event pins |
| Supabase | `calendar_events` table | Via `mcp__supabase__apply_migration` |
| Supabase | `geocode_cache` table | Via `mcp__supabase__apply_migration` |
| Supabase | `url_suggestions` table | Via `mcp__supabase__apply_migration` |

### Phase 3: Data Pipeline + Admin
| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `backend/src/lib/supabaseClient.js` | Shared Supabase client export for scrapers/routes |
| Create | `backend/src/scrapers/index.js` | Orchestrator: run all scrapers, normalize, dedup, upsert |
| Create | `backend/src/scrapers/sources/maratonypolskie.js` | Scraper for maratonypolskie.pl |
| Create | `backend/src/scrapers/sources/dostartu.js` | Scraper for dostartu.pl |
| Create | `backend/src/scrapers/normalizer.js` | Normalize raw data → calendar_events schema |
| Create | `backend/src/scrapers/dedup.js` | Cross-source deduplication |
| Create | `backend/src/scrapers/geocoder.js` | Location → lat/lng via Nominatim |
| Create | `backend/src/scrapers/urlResolver.js` | Brave Search for missing URLs |
| Create | `backend/src/routes/scrapers.js` | POST /api/scrapers/run |
| Create | `backend/src/routes/calendarEvents.js` | CRUD for manual calendar events |
| Create | `backend/src/routes/urlSuggestions.js` | CRUD for URL suggestion review |
| Create | `frontend/src/pages/UrlReview.jsx` | Admin UI: approve/reject URL suggestions |
| Create | `frontend/src/pages/CalendarEventForm.jsx` | Admin form: manually add calendar events |
| Modify | `backend/src/server.js` | Register new routes, start node-cron scheduler |
| Modify | `frontend/src/App.jsx` (or router) | Add admin routes for new pages |

---

## Phase 1: Landing Page

### Task 1: Accessibility — Fix CSS contrast tokens

**Files:**
- Modify: `public/src/app.css`

- [ ] **Step 1: Update color tokens for WCAG AA compliance**

In `public/src/app.css`, update the `@theme` block:
```css
/* Change these three values: */
--color-apex-muted: #8886A0;        /* was #545268 → 5.75:1 on bg */
--color-apex-red: #EF4444;          /* was #E53030 → 5.18:1 on surface */
--color-apex-dim: #605E78;          /* was #2C2A38 → 3.25:1 on bg */
```

- [ ] **Step 2: Verify the app still renders correctly**

Run: `cd /Users/derberg/Documents/GitHub/BeepBeep && docker compose up --build -d`
Open: `http://localhost:3002` (public app)
Check: existing pages (events, results) still look right with new colors.

- [ ] **Step 3: Commit**

```bash
git add public/src/app.css
git commit -m "fix: bump muted/red/dim colors for WCAG AA contrast compliance"
```

---

### Task 2: Shared Navbar component

**Files:**
- Create: `public/src/components/Navbar.jsx`

- [ ] **Step 1: Create the components directory**

```bash
mkdir -p public/src/components
```

- [ ] **Step 2: Write Navbar.jsx**

```jsx
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
```

- [ ] **Step 3: Commit**

```bash
git add public/src/components/Navbar.jsx
git commit -m "feat: add shared Navbar component with mobile hamburger menu"
```

---

### Task 3: Shared Footer component

**Files:**
- Create: `public/src/components/Footer.jsx`

- [ ] **Step 1: Write Footer.jsx**

```jsx
export default function Footer() {
  return (
    <footer className="border-t border-apex-border py-8 px-6 text-center text-xs text-apex-dim max-w-[1100px] mx-auto">
      <p>
        &copy; {new Date().getFullYear()} Leszy.run &middot; Pomiar czasu i obsluga wydarzen sportowych &middot;{' '}
        <a href="/polityka-prywatnosci" className="text-apex-muted no-underline hover:text-apex-yellow">
          Polityka prywatnosci
        </a>
      </p>
    </footer>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/Footer.jsx
git commit -m "feat: add shared Footer component"
```

---

### Task 4: Hero animations in app.css

**Files:**
- Modify: `public/src/app.css`

- [ ] **Step 1: Add hero animation keyframes and utility classes**

Append to `public/src/app.css` (after existing styles):
```css
/* Hero glow pulse */
@keyframes hero-pulse {
  0%, 100% { opacity: 0.6; transform: translate(-50%, -55%) scale(1); }
  50% { opacity: 1; transform: translate(-50%, -55%) scale(1.05); }
}

/* Scroll indicator bob */
@keyframes hero-bob {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(6px); }
}

/* Scanline overlay — apply to hero::before */
.hero-scanlines::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(187,221,0,0.015) 2px,
    rgba(187,221,0,0.015) 4px
  );
  pointer-events: none;
  z-index: 2;
}

/* Screen reader only */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/app.css
git commit -m "feat: add hero animation keyframes and utility classes"
```

---

### Task 5: Landing page component

**Files:**
- Create: `public/src/pages/Landing.jsx`

This is a large file. Build it section by section. Each section is a functional block within one component. The landing page fetches upcoming events from Supabase directly.

- [ ] **Step 1: Write Landing.jsx**

```jsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'

function HeroSection() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center text-center overflow-hidden px-6 pt-20 pb-16 hero-scanlines" aria-label="Glowna">
      {/* Radial glow */}
      <div className="absolute w-[400px] h-[400px] md:w-[600px] md:h-[600px] rounded-full top-1/2 left-1/2 -translate-x-1/2 -translate-y-[55%] z-0"
        style={{ background: 'radial-gradient(circle, rgba(45,90,39,0.1) 0%, rgba(45,90,39,0.04) 40%, transparent 70%)', animation: 'hero-pulse 6s ease-in-out infinite' }} />

      {/* Logo */}
      <img
        src="/logo-bez-napisu.svg"
        alt="Leszy.run — duch lasu"
        className="w-[200px] md:w-[400px] h-auto mb-6 relative z-10"
        style={{ filter: 'drop-shadow(0 0 30px rgba(45,90,39,0.4)) drop-shadow(0 0 60px rgba(45,90,39,0.2))' }}
      />

      <h1 className="font-display font-extrabold text-[44px] md:text-[72px] tracking-wider uppercase text-white relative z-10" style={{ textShadow: '0 0 60px rgba(187,221,0,0.2)' }}>
        LESZY<span className="text-apex-yellow">.RUN</span>
      </h1>

      <p className="font-sans font-semibold text-base md:text-lg tracking-widest uppercase text-apex-muted mt-2 relative z-10">
        Pomiar czasu &middot; Zapisy &middot; Wyniki na zywo
      </p>

      <p className="text-base md:text-[17px] text-apex-text mt-5 max-w-[500px] leading-relaxed relative z-10">
        Profesjonalna obsluga biegow i wydarzen sportowych. Zapisy, pomiar czasu, wyniki online — wszystko w jednym miejscu.
      </p>

      <div className="flex flex-col sm:flex-row gap-4 mt-9 relative z-10 w-full sm:w-auto">
        <Link to="/kalendarz" className="font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 bg-apex-yellow text-apex-bg no-underline hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all text-center">
          Znajdz bieg
        </Link>
        <a href="#kontakt" className="font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 border-2 border-apex-border-bright text-apex-text-bright no-underline hover:border-apex-yellow hover:text-apex-yellow transition-all text-center">
          Organizujesz wydarzenie?
        </a>
      </div>

      <div className="absolute bottom-6 left-1/2 text-apex-dim text-xs tracking-widest uppercase z-10"
        style={{ animation: 'hero-bob 2s ease-in-out infinite' }}>
        &#9660; Przewin w dol
      </div>
    </section>
  )
}

function FeatureCard({ icon, title, description }) {
  return (
    <div className="bg-apex-surface border border-apex-border p-6 md:p-8 relative group transition-all hover:border-apex-border-mid">
      <div className="absolute top-0 left-0 w-[3px] h-0 bg-apex-yellow transition-all group-hover:h-full" />
      <div className="font-mono text-2xl text-apex-yellow mb-4">{icon}</div>
      <h3 className="font-display font-bold text-xl tracking-wide uppercase text-apex-text-bright mb-2">{title}</h3>
      <p className="text-sm text-apex-muted leading-relaxed">{description}</p>
    </div>
  )
}

function OfertaSection() {
  return (
    <section id="oferta" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto" aria-label="Oferta">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Co oferujemy</p>
      <h2 className="font-display font-extrabold text-3xl md:text-[42px] tracking-wider uppercase text-apex-text-bright mb-4">Wszystko czego potrzebujesz</h2>
      <p className="text-base text-apex-text max-w-[600px] leading-relaxed mb-12">Od rejestracji zawodnikow po wyniki na mecie. Obslugujemy Twoje wydarzenie od A do Z.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0.5">
        <FeatureCard icon="···" title="Pomiar czasu" description="Precyzyjny pomiar z dokladnoscia do setnych sekundy. Wyniki widoczne natychmiast po przekroczeniu mety." />
        <FeatureCard icon="▶" title="Wyniki na zywo" description="Uczestnicy i kibice sledza wyniki w czasie rzeczywistym na telefonie. Podium aktualizuje sie automatycznie." />
        <FeatureCard icon="✎" title="Zapisy online" description="Formularz zapisow, zarzadzanie kategoriami, lista startowa. Wszystko gotowe w kilka minut." />
        <FeatureCard icon="★" title="Obsluga od A do Z" description="Nie musisz sie martwic o technologie. Przyjedziemy, ustawimy bramki i zajmiemy sie reszta." />
      </div>
    </section>
  )
}

function CharitySection() {
  return (
    <section className="bg-apex-surface border-t-[3px] border-t-apex-yellow border-b border-b-apex-border py-16 md:py-20 px-6 text-center" aria-label="Wydarzenia charytatywne">
      <div className="max-w-[700px] mx-auto">
        <h2 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-yellow mb-4">
          Wydarzenia charytatywne? Za darmo.
        </h2>
        <p className="text-[17px] text-apex-text leading-relaxed mb-8">
          Organizujesz bieg charytatywny? Zapisy, obsluga i pomiar czasu — wszystko za darmo. Jedyne co musisz zrobic to skontaktowac sie z nami i ustalic termin.
        </p>
        <a href="#kontakt" className="inline-block font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 bg-apex-yellow text-apex-bg no-underline hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
          Skontaktuj sie
        </a>
      </div>
    </section>
  )
}

function EventsSection() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    supabase
      .from('events')
      .select('id, name, date, location, slug')
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(5)
      .then(({ data }) => { setEvents(data || []); setLoading(false) })
  }, [])

  return (
    <section id="wydarzenia" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto" aria-label="Nadchodzace wydarzenia">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Nadchodzace wydarzenia</p>
      <h2 className="font-display font-extrabold text-3xl md:text-[42px] tracking-wider uppercase text-apex-text-bright mb-4">Najblizsze biegi</h2>
      <p className="text-base text-apex-text max-w-[600px] leading-relaxed mb-12">Wydarzenia obslugiwane przez Leszy.run. Kliknij aby zobaczyc szczegoly i zapisy.</p>

      {loading && <div className="text-apex-muted">Ladowanie...</div>}

      <div className="flex flex-col gap-0.5">
        {events.map(ev => (
          <Link key={ev.id} to={`/events/${ev.slug}`} className="grid grid-cols-[80px_1fr] md:grid-cols-[100px_1fr_auto] items-center gap-4 md:gap-6 bg-apex-surface border border-apex-border px-4 md:px-6 py-4 md:py-5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all no-underline text-inherit">
            <div className="font-mono text-[13px] font-semibold text-apex-yellow">{ev.date}</div>
            <div>
              <div className="font-display font-bold text-base md:text-lg tracking-wide uppercase text-apex-text-bright">{ev.name}</div>
              {ev.location && <div className="text-xs text-apex-muted mt-0.5">{ev.location}</div>}
            </div>
            <div className="hidden md:block text-apex-dim text-lg">&rarr;</div>
          </Link>
        ))}
      </div>

      {!loading && events.length === 0 && (
        <p className="text-apex-muted">Brak nadchodzacych wydarzen.</p>
      )}
    </section>
  )
}

function KalendarzTeaser() {
  const [events, setEvents] = useState([])

  useEffect(() => {
    supabase
      .from('calendar_events')
      .select('id, name, date, location, leszyrun_event_id')
      .gte('date', new Date().toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(5)
      .then(({ data }) => setEvents(data || []))
  }, [])

  return (
    <section id="kalendarz" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto" aria-label="Kalendarz biegow">
      <div className="bg-apex-surface border border-apex-border p-8 md:p-12 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center">
        <div>
          <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Kalendarz biegow</p>
          <h3 className="font-display font-extrabold text-2xl md:text-4xl tracking-wider uppercase text-apex-text-bright mb-3">
            Wszystkie biegi w Polsce w jednym miejscu
          </h3>
          <p className="text-[15px] text-apex-text leading-relaxed mb-6">
            Przegladaj setki biegow, marszow nordic walking i wydarzen sportowych z calej Polski. Filtruj po regionie, dystansie i typie.
          </p>
          <Link to="/kalendarz" className="inline-block font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 bg-apex-yellow text-apex-bg no-underline hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
            Otworz kalendarz
          </Link>
        </div>

        <div className="flex flex-col gap-1.5">
          {events.map(ev => (
            <div key={ev.id} className="flex items-center gap-3 px-3.5 py-2.5 bg-apex-surface-2 border border-apex-border text-[13px]">
              <span className="font-mono text-[11px] text-apex-yellow-dim min-w-[50px]">
                {new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })}
              </span>
              <span className="font-semibold text-apex-text-bright truncate">{ev.name}</span>
              {ev.leszyrun_event_id && (
                <span className="font-mono text-[9px] font-semibold tracking-wide px-1.5 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20 ml-auto flex-shrink-0">
                  LESZY.RUN
                </span>
              )}
              <span className="text-apex-muted text-xs ml-auto flex-shrink-0">{ev.location}</span>
            </div>
          ))}
          {events.length === 0 && (
            <div className="text-apex-muted text-sm py-4 text-center">Kalendarz wkrotce...</div>
          )}
        </div>
      </div>
    </section>
  )
}

function ContactSection() {
  return (
    <section id="kontakt" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto text-center" aria-label="Kontakt">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Kontakt</p>
      <h2 className="font-display font-extrabold text-3xl md:text-[42px] tracking-wider uppercase text-apex-text-bright mb-4">Porozmawiajmy</h2>
      <p className="text-base text-apex-text max-w-[600px] leading-relaxed mb-8 mx-auto">
        Chcesz zorganizowac bieg? Masz pytania? Napisz do nas — odpowiemy najszybciej jak mozemy.
      </p>
      <div className="flex flex-col sm:flex-row gap-6 justify-center">
        {[
          { label: 'Email', value: 'kontakt@leszy.run' },
          { label: 'Telefon', value: '+48 XXX XXX XXX' },
          { label: 'Instagram', value: '@leszy.run' },
        ].map(item => (
          <div key={item.label} className="flex flex-col items-center gap-2 px-8 py-6 bg-apex-surface border border-apex-border min-w-[180px]">
            <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted">{item.label}</span>
            <span className="font-display font-bold text-lg text-apex-text-bright tracking-wide">{item.value}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function Landing() {
  return (
    <>
      <Navbar />
      <main id="main-content">
        <HeroSection />
        <div className="w-full h-px bg-apex-border" />
        <OfertaSection />
        <div className="w-full h-px bg-apex-border" />
        <CharitySection />
        <div className="w-full h-px bg-apex-border" />
        <EventsSection />
        <div className="w-full h-px bg-apex-border" />
        <KalendarzTeaser />
        <div className="w-full h-px bg-apex-border" />
        <ContactSection />
      </main>
      <Footer />
    </>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/Landing.jsx
git commit -m "feat: add Landing page with all 7 sections"
```

---

### Task 6: Wire up routes and update index.html

**Files:**
- Modify: `public/src/App.jsx`
- Modify: `public/index.html`

- [ ] **Step 1: Update App.jsx to add Landing route**

Add import at top:
```jsx
import Landing from './pages/Landing.jsx'
```

Add route before the catch-all:
```jsx
<Route path="/" element={<Landing />} />
```

The full `App.jsx` should look like:
```jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Landing from './pages/Landing.jsx'
import Home from './pages/Home.jsx'
import EventHub from './pages/EventHub.jsx'
import Results from './pages/Results.jsx'
import Volunteer from './pages/Volunteer.jsx'
import Checkin from './pages/Checkin.jsx'
import AdminCheckin from './pages/AdminCheckin.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/events" element={<Home />} />
      <Route path="/events/:slug" element={<EventHub />} />
      <Route path="/events/:slug/results" element={<Results />} />
      <Route path="/events/:slug/results/live" element={<Results />} />
      <Route path="/events/:slug/results/:categoryId" element={<Results />} />
      <Route path="/events/:slug/volunteer" element={<Volunteer />} />
      <Route path="/events/:slug/checkin" element={<Checkin />} />
      <Route path="/events/:slug/admin/checkin" element={<AdminCheckin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 2: Update index.html title**

Change `<title>LeszyRun</title>` to `<title>Leszy.run — Pomiar czasu i obsluga biegow</title>`.

- [ ] **Step 3: Verify the landing page loads**

Run: `docker compose up --build -d`
Open: `http://localhost:3002`
Verify: landing page renders at `/`, old events list still works at `/events`.

- [ ] **Step 4: Commit**

```bash
git add public/src/App.jsx public/index.html
git commit -m "feat: wire up Landing page at / route, update page title"
```

---

### CHECKPOINT: Phase 1 Complete

At this point the landing page is fully functional. Review:
- [ ] Landing page loads at `/` with all 7 sections
- [ ] Navbar works on mobile (hamburger) and desktop
- [ ] Hash links scroll smoothly to sections
- [ ] Upcoming events load from Supabase
- [ ] Kalendarz teaser shows placeholder (calendar_events table doesn't exist yet — that's fine)
- [ ] WCAG AA contrast is correct
- [ ] Mobile layout is clean and usable

---

## Phase 2: Kalendarz Page

### Task 7: Create Supabase tables

**Files:**
- Supabase migration (via MCP tool)

- [ ] **Step 1: Create calendar_events table**

Use `mcp__supabase__apply_migration` with name `create_calendar_events` and the SQL from the spec:
```sql
CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  date DATE NOT NULL,
  end_date DATE,
  location TEXT,
  voivodeship TEXT,
  lat DECIMAL(9,6),
  lng DECIMAL(9,6),
  event_type TEXT[],
  distances TEXT[],
  distances_meters INT[],
  description TEXT,
  registration_url TEXT,
  registration_deadline DATE,
  price_from INT,
  price_to INT,
  organizer TEXT,
  website TEXT,
  is_recurring BOOLEAN DEFAULT false,
  recurring_event_id UUID,
  edition_number INT,
  surface TEXT[],
  elevation_gain_m INT,
  max_participants INT,
  is_night BOOLEAN DEFAULT false,
  is_charity BOOLEAN DEFAULT false,
  source TEXT NOT NULL,
  source_url TEXT,
  source_id TEXT,
  leszyrun_event_id UUID,
  status TEXT DEFAULT 'active',
  last_verified_at TIMESTAMPTZ DEFAULT now(),
  scraped_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_calendar_events_date ON calendar_events(date);
CREATE INDEX idx_calendar_events_voivodeship ON calendar_events(voivodeship);
CREATE INDEX idx_calendar_events_source ON calendar_events(source, source_id);
CREATE INDEX idx_calendar_events_recurring ON calendar_events(recurring_event_id);
CREATE INDEX idx_calendar_events_status ON calendar_events(status);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON calendar_events FOR SELECT USING (true);
```

- [ ] **Step 2: Create geocode_cache table**

Use `mcp__supabase__apply_migration` with name `create_geocode_cache`:
```sql
CREATE TABLE geocode_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_query TEXT NOT NULL UNIQUE,
  lat DECIMAL(9,6),
  lng DECIMAL(9,6),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 3: Create url_suggestions table**

Use `mcp__supabase__apply_migration` with name `create_url_suggestions`:
```sql
CREATE TABLE url_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  search_query TEXT NOT NULL,
  search_engine TEXT DEFAULT 'brave',
  rank INT NOT NULL,
  url TEXT NOT NULL,
  page_title TEXT,
  snippet TEXT,
  status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_url_suggestions_status ON url_suggestions(status);
CREATE INDEX idx_url_suggestions_event ON url_suggestions(calendar_event_id);

ALTER TABLE url_suggestions ENABLE ROW LEVEL SECURITY;
```

---

### Task 8: Install Leaflet dependencies

**Files:**
- Modify: `public/package.json`

- [ ] **Step 1: Install leaflet and react-leaflet**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep && npm install leaflet react-leaflet --workspace=public
```

- [ ] **Step 2: Commit**

```bash
git add public/package.json package-lock.json
git commit -m "feat: add leaflet and react-leaflet to public app"
```

---

### Task 9: FilterBar component

**Files:**
- Create: `public/src/components/FilterBar.jsx`

- [ ] **Step 1: Write FilterBar.jsx**

```jsx
const EVENT_TYPES = [
  { value: '', label: 'Typ: Wszystkie' },
  { value: 'uliczny', label: 'Bieg uliczny' },
  { value: 'trail', label: 'Trail' },
  { value: 'ultra', label: 'Ultramaraton' },
  { value: 'nordic', label: 'Nordic Walking' },
  { value: 'ocr', label: 'OCR' },
  { value: 'nocny', label: 'Bieg nocny' },
  { value: 'charytatywny', label: 'Charytatywny' },
]

const VOIVODESHIPS = [
  '', 'Dolnoslaskie', 'Kujawsko-Pomorskie', 'Lodzkie', 'Lubelskie', 'Lubuskie',
  'Malopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Slaskie', 'Swietokrzyskie', 'Warminsko-Mazurskie', 'Wielkopolskie', 'Zachodniopomorskie',
]

const DISTANCES = [
  { value: '', label: 'Dystans: Wszystkie' },
  { value: '0-5000', label: 'do 5 km' },
  { value: '5000-10000', label: '5-10 km' },
  { value: '10000-21100', label: '10-21 km' },
  { value: '21100-21100', label: 'Polmaraton' },
  { value: '42200-42200', label: 'Maraton' },
  { value: '50000-999999', label: 'Ultra (50+ km)' },
]

const TIME_RANGES = [
  { value: '', label: 'Kiedy: Najblizsze' },
  { value: 'week', label: 'Ten tydzien' },
  { value: 'month', label: 'Ten miesiac' },
  { value: 'next-month', label: 'Nastepny miesiac' },
  { value: '3months', label: 'Za 3 miesiace' },
  { value: 'year', label: 'Caly rok' },
]

const selectClass = "bg-apex-surface border border-apex-border text-apex-text font-sans text-sm font-semibold py-2.5 pl-3.5 pr-8 outline-none appearance-none cursor-pointer focus:border-apex-yellow-dim w-full md:w-auto"

export default function FilterBar({ filters, onChange, view, onViewChange }) {
  const update = (key, value) => onChange({ ...filters, [key]: value })

  return (
    <div className="sticky top-14 z-40 bg-apex-bg/92 backdrop-blur-md border-b border-apex-border py-4 px-6">
      <div className="max-w-[1200px] mx-auto flex flex-col md:flex-row gap-3 items-stretch md:items-center">
        <input
          type="text"
          placeholder="Szukaj po nazwie, miejscu..."
          value={filters.search}
          onChange={(e) => update('search', e.target.value)}
          className="flex-1 min-w-[200px] bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-[15px] font-medium py-2.5 px-4 outline-none focus:border-apex-yellow-dim placeholder:text-apex-muted"
          aria-label="Szukaj wydarzen"
        />

        <select value={filters.type} onChange={(e) => update('type', e.target.value)} className={selectClass} aria-label="Filtruj po typie">
          {EVENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        <select value={filters.voivodeship} onChange={(e) => update('voivodeship', e.target.value)} className={selectClass} aria-label="Filtruj po regionie">
          <option value="">Region: Cala Polska</option>
          {VOIVODESHIPS.filter(Boolean).map(v => <option key={v} value={v}>{v}</option>)}
        </select>

        <select value={filters.distance} onChange={(e) => update('distance', e.target.value)} className={selectClass} aria-label="Filtruj po dystansie">
          {DISTANCES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>

        <select value={filters.timeRange} onChange={(e) => update('timeRange', e.target.value)} className={selectClass} aria-label="Filtruj po czasie">
          {TIME_RANGES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        <div className="flex border border-apex-border overflow-hidden flex-shrink-0" role="group" aria-label="Widok">
          <button onClick={() => onViewChange('list')}
            className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'list' ? 'bg-apex-yellow text-apex-bg' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
            Lista
          </button>
          <button onClick={() => onViewChange('map')}
            className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 transition-all ${view === 'map' ? 'bg-apex-yellow text-apex-bg' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
            Mapa
          </button>
        </div>
      </div>
    </div>
  )
}

export { EVENT_TYPES, VOIVODESHIPS, DISTANCES, TIME_RANGES }
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/FilterBar.jsx
git commit -m "feat: add FilterBar component with all filter options"
```

---

### Task 10: EventRow component

**Files:**
- Create: `public/src/components/EventRow.jsx`

- [ ] **Step 1: Write EventRow.jsx**

```jsx
const TAG_STYLES = {
  trail: 'border-[rgba(74,138,66,0.4)] text-[#4A8A42]',
  nocny: 'border-[rgba(0,191,239,0.3)] text-[#00BFEF]',
  charytatywny: 'border-[rgba(187,221,0,0.3)] text-apex-yellow',
  ocr: 'border-[rgba(239,68,68,0.3)] text-[#EF4444]',
  nordic: 'border-[rgba(187,221,0,0.2)] text-apex-yellow-dim',
  uliczny: 'border-apex-border-mid text-apex-muted',
}

function EventTag({ type }) {
  const style = TAG_STYLES[type] || TAG_STYLES.uliczny
  return (
    <span className={`font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border ${style} uppercase`}>
      {type}
    </span>
  )
}

export default function EventRow({ event }) {
  const dateStr = new Date(event.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })
  const isLeszyrun = !!event.leszyrun_event_id

  const handleClick = () => {
    if (isLeszyrun && event.slug) {
      window.location.href = `/events/${event.slug}`
    } else if (event.registration_url) {
      window.open(event.registration_url, '_blank', 'noopener')
    }
  }

  return (
    <div
      onClick={handleClick}
      className="grid grid-cols-[70px_1fr] md:grid-cols-[90px_1fr_auto_auto_auto] items-center gap-2 md:gap-4 px-3 md:px-4 py-3 md:py-3.5 bg-apex-surface border border-apex-border mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all cursor-pointer"
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className="font-mono text-[13px] font-semibold text-apex-yellow">{dateStr}</div>

      <div className="min-w-0">
        <div className="font-display font-bold text-[15px] md:text-[17px] tracking-wide uppercase text-apex-text-bright truncate">{event.name}</div>
        <div className="text-[13px] text-apex-muted mt-0.5 flex gap-2 items-center">
          <span>{event.location}{event.voivodeship ? `, ${event.voivodeship}` : ''}</span>
          {event.source && <span>&middot; {event.source}</span>}
        </div>
      </div>

      <div className="hidden md:flex gap-1 flex-shrink-0">
        {(event.event_type || []).map(t => <EventTag key={t} type={t} />)}
      </div>

      <div className="hidden md:block font-mono text-xs text-apex-text flex-shrink-0 text-right">
        {(event.distances || []).join(' / ')}
      </div>

      {isLeszyrun ? (
        <span className="hidden md:block font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20 flex-shrink-0">
          LESZY.RUN
        </span>
      ) : <div className="hidden md:block" />}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/EventRow.jsx
git commit -m "feat: add EventRow component with color-coded tags"
```

---

### Task 11: MapView component

**Files:**
- Create: `public/src/components/MapView.jsx`

- [ ] **Step 1: Write MapView.jsx**

```jsx
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const defaultPin = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
})

// Poland center
const POLAND_CENTER = [52.0, 19.5]
const POLAND_ZOOM = 6

export default function MapView({ events }) {
  const mappable = events.filter(e => e.lat && e.lng)

  return (
    <div className="max-w-[1200px] mx-auto px-6 pb-16">
      <MapContainer
        center={POLAND_CENTER}
        zoom={POLAND_ZOOM}
        className="w-full h-[500px] border border-apex-border"
        style={{ background: '#0C0C14' }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
        />
        {mappable.map(ev => (
          <Marker key={ev.id} position={[Number(ev.lat), Number(ev.lng)]} icon={defaultPin}>
            <Popup>
              <div style={{ fontFamily: 'Rajdhani, sans-serif' }}>
                <strong>{ev.name}</strong><br />
                {ev.date} &middot; {ev.location}<br />
                {ev.registration_url && (
                  <a href={ev.registration_url} target="_blank" rel="noopener">Zapisy &rarr;</a>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/MapView.jsx
git commit -m "feat: add MapView component with dark CartoDB tiles"
```

---

### Task 12: Kalendarz page

**Files:**
- Create: `public/src/pages/Kalendarz.jsx`
- Modify: `public/src/App.jsx`

- [ ] **Step 1: Write Kalendarz.jsx**

```jsx
import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import FilterBar from '../components/FilterBar.jsx'
import EventRow from '../components/EventRow.jsx'
import MapView from '../components/MapView.jsx'

const PAGE_SIZE = 30

function getDateRange(timeRange) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let end = null

  switch (timeRange) {
    case 'week': end = new Date(start); end.setDate(end.getDate() + 7); break
    case 'month': end = new Date(start.getFullYear(), start.getMonth() + 1, 0); break
    case 'next-month': {
      const s = new Date(start.getFullYear(), start.getMonth() + 1, 1)
      end = new Date(start.getFullYear(), start.getMonth() + 2, 0)
      return [s.toISOString().split('T')[0], end.toISOString().split('T')[0]]
    }
    case '3months': end = new Date(start); end.setMonth(end.getMonth() + 3); break
    case 'year': end = new Date(start.getFullYear(), 11, 31); break
    default: break
  }

  return [
    start.toISOString().split('T')[0],
    end ? end.toISOString().split('T')[0] : null,
  ]
}

export default function Kalendarz() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(searchParams.get('view') || 'list')
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10))

  const [filters, setFilters] = useState({
    search: searchParams.get('q') || '',
    type: searchParams.get('type') || '',
    voivodeship: searchParams.get('region') || '',
    distance: searchParams.get('dist') || '',
    timeRange: searchParams.get('when') || '',
  })

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('calendar_events')
      .select('*', { count: 'exact' })
      .eq('status', 'active')
      .order('date', { ascending: true })

    // Date range
    const [startDate, endDate] = getDateRange(filters.timeRange)
    query = query.gte('date', startDate)
    if (endDate) query = query.lte('date', endDate)

    // Search
    if (filters.search) {
      query = query.or(`name.ilike.%${filters.search}%,location.ilike.%${filters.search}%`)
    }

    // Type
    if (filters.type) {
      query = query.contains('event_type', [filters.type])
    }

    // Region
    if (filters.voivodeship) {
      query = query.eq('voivodeship', filters.voivodeship)
    }

    // Distance
    if (filters.distance) {
      const [min, max] = filters.distance.split('-').map(Number)
      query = query.overlaps('distances_meters', Array.from({ length: max - min + 1 }, (_, i) => min + i))
      // Note: overlaps with a range array is not ideal. Alternative approach below.
    }

    // Pagination
    const from = (page - 1) * PAGE_SIZE
    query = query.range(from, from + PAGE_SIZE - 1)

    const { data, count } = await query
    setEvents(data || [])
    setTotal(count || 0)
    setLoading(false)
  }, [filters, page])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // Sync filters to URL
  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.search) params.set('q', filters.search)
    if (filters.type) params.set('type', filters.type)
    if (filters.voivodeship) params.set('region', filters.voivodeship)
    if (filters.distance) params.set('dist', filters.distance)
    if (filters.timeRange) params.set('when', filters.timeRange)
    if (view !== 'list') params.set('view', view)
    if (page > 1) params.set('page', String(page))
    setSearchParams(params, { replace: true })
  }, [filters, view, page, setSearchParams])

  // Group events by month
  const grouped = events.reduce((acc, ev) => {
    const d = new Date(ev.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
    if (!acc[key]) acc[key] = { label, events: [] }
    acc[key].events.push(ev)
    return acc
  }, {})

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <>
      <Navbar />
      <main id="main-content">
        <div className="pt-20 md:pt-20 pb-8 px-6 max-w-[1200px] mx-auto">
          <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">Kalendarz biegow</p>
          <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">Wszystkie biegi w Polsce</h1>
          <p className="text-base text-apex-text max-w-[600px]">Setki biegow, marszow nordic walking i wydarzen sportowych z calej Polski.</p>
        </div>

        <FilterBar filters={filters} onChange={(f) => { setFilters(f); setPage(1) }} view={view} onViewChange={setView} />

        <div className="max-w-[1200px] mx-auto px-6 pt-4 pb-2 flex justify-between items-center">
          <span className="font-mono text-xs text-apex-muted tracking-wide">
            Znaleziono <strong className="text-apex-yellow">{total}</strong> wydarzen
          </span>
        </div>

        {view === 'list' ? (
          <div className="max-w-[1200px] mx-auto px-6 pb-16">
            {loading && <div className="text-apex-muted py-8">Ladowanie...</div>}

            {!loading && Object.entries(grouped).map(([key, group]) => (
              <div key={key} className="mb-2">
                <div className="font-display font-bold text-base tracking-widest uppercase text-apex-yellow-dim py-5 border-b border-apex-border mb-0.5">
                  {group.label}
                </div>
                {group.events.map(ev => <EventRow key={ev.id} event={ev} />)}
              </div>
            ))}

            {!loading && events.length === 0 && (
              <div className="text-apex-muted py-12 text-center">Brak wydarzen dla wybranych filtrow.</div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center gap-1 pt-8">
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`font-mono text-[13px] px-3.5 py-2 border transition-all ${p === page ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright'}`}
                  >
                    {p}
                  </button>
                ))}
                {totalPages > 7 && <span className="font-mono text-[13px] px-2 py-2 text-apex-muted">...</span>}
                {totalPages > 7 && (
                  <button
                    onClick={() => setPage(totalPages)}
                    className={`font-mono text-[13px] px-3.5 py-2 border transition-all ${totalPages === page ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright'}`}
                  >
                    {totalPages}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <MapView events={events} />
        )}
      </main>
      <Footer />
    </>
  )
}
```

- [ ] **Step 2: Add route to App.jsx**

Add import:
```jsx
import Kalendarz from './pages/Kalendarz.jsx'
```

Add route after landing:
```jsx
<Route path="/kalendarz" element={<Kalendarz />} />
```

- [ ] **Step 3: Verify kalendarz loads**

Run: `docker compose up --build -d`
Open: `http://localhost:3002/kalendarz`
Verify: page renders, filters work, empty state shows. Map view switches correctly.

- [ ] **Step 4: Commit**

```bash
git add public/src/pages/Kalendarz.jsx public/src/App.jsx
git commit -m "feat: add Kalendarz page with filters, list view, map view, and pagination"
```

---

### CHECKPOINT: Phase 2 Complete

- [ ] Kalendarz page loads at `/kalendarz`
- [ ] Filters update URL params (shareable)
- [ ] List view groups events by month
- [ ] Map view renders dark tiles with pins
- [ ] Pagination works
- [ ] Empty state shows when no events match
- [ ] Mobile layout is usable (stacked filters, simplified rows)

---

## Phase 3: Data Pipeline & Admin

### Task 13: Install backend dependencies

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install cheerio and node-cron**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep && npm install cheerio node-cron --workspace=backend
```

- [ ] **Step 2: Commit**

```bash
git add backend/package.json package-lock.json
git commit -m "feat: add cheerio and node-cron to backend"
```

---

### Task 14: Shared Supabase client for scrapers

**Files:**
- Create: `backend/src/lib/supabaseClient.js`

- [ ] **Step 1: Write supabaseClient.js**

```javascript
// backend/src/lib/supabaseClient.js
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.warn('[supabaseClient] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — Supabase features disabled')
}

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null

export { supabase }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/lib/supabaseClient.js
git commit -m "feat: add shared Supabase client export for scrapers and routes"
```

---

### Task 15: Geocoder module

**Files:**
- Create: `backend/src/scrapers/geocoder.js`

- [ ] **Step 1: Create scrapers directory and geocoder**

```bash
mkdir -p backend/src/scrapers/sources
```

```javascript
// backend/src/scrapers/geocoder.js
import { supabase } from '../lib/supabaseClient.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const RATE_LIMIT_MS = 1100 // 1 req/sec

let lastRequestAt = 0

async function geocode(locationQuery) {
  if (!locationQuery) return { lat: null, lng: null }

  // Check cache first
  const { data: cached } = await supabase
    .from('geocode_cache')
    .select('lat, lng')
    .eq('location_query', locationQuery)
    .single()

  if (cached) return { lat: cached.lat, lng: cached.lng }

  // Rate limit
  const now = Date.now()
  const wait = RATE_LIMIT_MS - (now - lastRequestAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastRequestAt = Date.now()

  try {
    const params = new URLSearchParams({
      q: `${locationQuery}, Polska`,
      format: 'json',
      limit: '1',
      countrycodes: 'pl',
    })

    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })

    const results = await res.json()

    if (results.length > 0) {
      const { lat, lon } = results[0]
      const coords = { lat: parseFloat(lat), lng: parseFloat(lon) }

      // Cache result
      await supabase.from('geocode_cache').upsert({
        location_query: locationQuery,
        lat: coords.lat,
        lng: coords.lng,
      }, { onConflict: 'location_query' })

      return coords
    }
  } catch (err) {
    console.error(`Geocode failed for "${locationQuery}":`, err.message)
  }

  return { lat: null, lng: null }
}

export { geocode }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/geocoder.js
git commit -m "feat: add geocoder with Nominatim + Supabase cache"
```

---

### Task 15: Normalizer module

**Files:**
- Create: `backend/src/scrapers/normalizer.js`

- [ ] **Step 1: Write normalizer.js**

```javascript
// backend/src/scrapers/normalizer.js
import { geocode } from './geocoder.js'

const TYPE_KEYWORDS = {
  trail: ['trail', 'gorski', 'gorsky', 'terenowy'],
  nocny: ['nocny', 'night', 'noc'],
  ocr: ['ocr', 'runmageddon', 'spartan', 'barbarian', 'survival'],
  nordic: ['nordic', 'marsz', 'nordic walking'],
  ultra: ['ultra', 'ultramaraton'],
  charytatywny: ['charytatywny', 'charity', 'dla schroniska', 'dla hospicjum', 'dla dzieci'],
}

function classifyType(name, description = '') {
  const text = `${name} ${description}`.toLowerCase()
  const types = []

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      types.push(type)
    }
  }

  if (types.length === 0) types.push('uliczny')
  return types
}

function parseDistances(distanceText) {
  if (!distanceText) return { distances: [], distances_meters: [] }

  const distances = []
  const meters = []

  // Match patterns like "5 km", "21.1km", "42,2 km", "półmaraton", "maraton"
  const kmMatches = distanceText.matchAll(/(\d+[.,]?\d*)\s*km/gi)
  for (const m of kmMatches) {
    const km = parseFloat(m[1].replace(',', '.'))
    distances.push(`${km} km`)
    meters.push(Math.round(km * 1000))
  }

  if (distanceText.toLowerCase().includes('polmaraton') || distanceText.toLowerCase().includes('półmaraton')) {
    if (!meters.includes(21100)) {
      distances.push('21.1 km')
      meters.push(21100)
    }
  }

  if (distanceText.toLowerCase().includes('maraton') && !distanceText.toLowerCase().includes('pol') && !distanceText.toLowerCase().includes('pół') && !distanceText.toLowerCase().includes('ultra')) {
    if (!meters.includes(42200)) {
      distances.push('42.2 km')
      meters.push(42200)
    }
  }

  return { distances, distances_meters: meters.sort((a, b) => a - b) }
}

function parseDate(dateText) {
  if (!dateText) return null

  // Try ISO format first
  const isoMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return isoMatch[0]

  // Try dd.mm.yyyy or dd/mm/yyyy
  const euMatch = dateText.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/)
  if (euMatch) return `${euMatch[3]}-${euMatch[2].padStart(2, '0')}-${euMatch[1].padStart(2, '0')}`

  // Try Polish month names
  const months = {
    stycznia: '01', lutego: '02', marca: '03', kwietnia: '04',
    maja: '05', czerwca: '06', lipca: '07', sierpnia: '08',
    wrzesnia: '09', pazdziernika: '10', listopada: '11', grudnia: '12',
    'września': '09', 'października': '10',
  }

  for (const [name, num] of Object.entries(months)) {
    const re = new RegExp(`(\\d{1,2})\\s+${name}\\s+(\\d{4})`, 'i')
    const m = dateText.match(re)
    if (m) return `${m[2]}-${num}-${m[1].padStart(2, '0')}`
  }

  return null
}

async function normalizeEvent(raw) {
  const date = parseDate(raw.date)
  if (!date) return null

  const { distances, distances_meters } = parseDistances(raw.distances || '')
  const eventType = classifyType(raw.name, raw.description)
  const { lat, lng } = await geocode(raw.location)

  return {
    name: raw.name.trim(),
    date,
    end_date: raw.end_date ? parseDate(raw.end_date) : null,
    location: raw.location || null,
    voivodeship: raw.voivodeship || null,
    lat,
    lng,
    event_type: eventType,
    distances,
    distances_meters,
    description: raw.description || null,
    registration_url: raw.registration_url || null,
    registration_deadline: raw.registration_deadline ? parseDate(raw.registration_deadline) : null,
    price_from: raw.price_from || null,
    price_to: raw.price_to || null,
    organizer: raw.organizer || null,
    website: raw.website || null,
    is_night: eventType.includes('nocny'),
    is_charity: eventType.includes('charytatywny'),
    source: raw.source,
    source_url: raw.source_url || null,
    source_id: raw.source_id || null,
  }
}

export { normalizeEvent, classifyType, parseDistances, parseDate }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/normalizer.js
git commit -m "feat: add event normalizer with date/distance/type parsing"
```

---

### Task 16: Dedup module

**Files:**
- Create: `backend/src/scrapers/dedup.js`

- [ ] **Step 1: Write dedup.js**

```javascript
// backend/src/scrapers/dedup.js
import { supabase } from '../lib/supabaseClient.js'

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

function nameSimilarity(a, b) {
  const normA = a.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').trim()
  const normB = b.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').trim()
  const maxLen = Math.max(normA.length, normB.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(normA, normB) / maxLen
}

async function findExistingMatch(event) {
  // First check: exact source match
  if (event.source_id) {
    const { data } = await supabase
      .from('calendar_events')
      .select('id')
      .eq('source', event.source)
      .eq('source_id', event.source_id)
      .single()

    if (data) return data.id
  }

  // Second check: cross-source match by name + date
  const { data: candidates } = await supabase
    .from('calendar_events')
    .select('id, name, location')
    .eq('date', event.date)

  if (candidates) {
    for (const candidate of candidates) {
      if (nameSimilarity(candidate.name, event.name) > 0.8) {
        return candidate.id
      }
    }
  }

  return null
}

async function upsertEvent(event) {
  const existingId = await findExistingMatch(event)

  if (existingId) {
    // Merge: update with richer data (non-null fields win)
    const updates = {}
    for (const [key, value] of Object.entries(event)) {
      if (value !== null && value !== undefined) {
        updates[key] = value
      }
    }
    updates.updated_at = new Date().toISOString()
    updates.last_verified_at = new Date().toISOString()

    const { error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', existingId)

    return { action: 'updated', id: existingId, error }
  } else {
    const { data, error } = await supabase
      .from('calendar_events')
      .insert(event)
      .select('id')
      .single()

    return { action: 'created', id: data?.id, error }
  }
}

export { findExistingMatch, upsertEvent, nameSimilarity }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/dedup.js
git commit -m "feat: add dedup module with Levenshtein cross-source matching"
```

---

### Task 17: Maratonypolskie scraper

**Files:**
- Create: `backend/src/scrapers/sources/maratonypolskie.js`

- [ ] **Step 1: Write maratonypolskie.js**

This is a skeleton — the exact selectors will need to be discovered by inspecting the actual website HTML. The implementer should visit `https://maratonypolskie.pl` and adjust selectors accordingly.

```javascript
// backend/src/scrapers/sources/maratonypolskie.js
import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'

async function scrape() {
  const results = []

  try {
    // TODO: inspect maratonypolskie.pl HTML structure and adjust selectors
    // The URL pattern and selectors below are placeholders
    const res = await fetch(`${BASE_URL}/kalendarz`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Example selector pattern — adjust after inspecting real HTML:
    // Each event is likely in a card/row element with date, name, location, distance
    $('[class*="event"], [class*="row"], tr').each((_, el) => {
      const name = $(el).find('[class*="name"], [class*="title"], td:nth-child(2)').text().trim()
      const date = $(el).find('[class*="date"], td:nth-child(1)').text().trim()
      const location = $(el).find('[class*="location"], [class*="place"], td:nth-child(3)').text().trim()
      const distances = $(el).find('[class*="distance"], [class*="dystans"], td:nth-child(4)').text().trim()
      const link = $(el).find('a').attr('href')

      if (name && date) {
        results.push({
          name,
          date,
          location,
          distances,
          registration_url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
          source: 'maratonypolskie',
          source_url: `${BASE_URL}/kalendarz`,
          source_id: link || `${name}-${date}`,
        })
      }
    })

    console.log(`[maratonypolskie] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[maratonypolskie] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/sources/maratonypolskie.js
git commit -m "feat: add maratonypolskie.pl scraper skeleton"
```

---

### Task 18: Dostartu scraper

**Files:**
- Create: `backend/src/scrapers/sources/dostartu.js`

- [ ] **Step 1: Write dostartu.js**

Same pattern as maratonypolskie — skeleton with placeholder selectors.

```javascript
// backend/src/scrapers/sources/dostartu.js
import * as cheerio from 'cheerio'

const BASE_URL = 'https://dostartu.pl'

async function scrape() {
  const results = []

  try {
    // TODO: inspect dostartu.pl HTML structure and adjust selectors
    const res = await fetch(`${BASE_URL}/kalendarz-biegow`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Adjust selectors after inspecting real HTML
    $('[class*="event"], [class*="item"]').each((_, el) => {
      const name = $(el).find('[class*="name"], [class*="title"], h3, h4').text().trim()
      const date = $(el).find('[class*="date"]').text().trim()
      const location = $(el).find('[class*="location"], [class*="place"]').text().trim()
      const distances = $(el).find('[class*="distance"], [class*="dystans"]').text().trim()
      const link = $(el).find('a').attr('href')

      if (name && date) {
        results.push({
          name,
          date,
          location,
          distances,
          registration_url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
          source: 'dostartu',
          source_url: `${BASE_URL}/kalendarz-biegow`,
          source_id: link || `${name}-${date}`,
        })
      }
    })

    console.log(`[dostartu] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[dostartu] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/sources/dostartu.js
git commit -m "feat: add dostartu.pl scraper skeleton"
```

---

### Task 19: URL Resolver module

**Files:**
- Create: `backend/src/scrapers/urlResolver.js`

- [ ] **Step 1: Write urlResolver.js**

```javascript
// backend/src/scrapers/urlResolver.js
import { supabase } from '../lib/supabaseClient.js'

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'

async function searchBrave(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) return []

  try {
    const params = new URLSearchParams({ q: query, count: '3' })
    const res = await fetch(`${BRAVE_API_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    })

    const data = await res.json()
    return (data.web?.results || []).slice(0, 3).map((r, i) => ({
      rank: i + 1,
      url: r.url,
      page_title: r.title,
      snippet: r.description,
    }))
  } catch (err) {
    console.error(`Brave search failed for "${query}":`, err.message)
    return []
  }
}

async function resolveUrls() {
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.log('[urlResolver] BRAVE_SEARCH_API_KEY not set, skipping')
    return { processed: 0, suggestions: 0 }
  }

  // Find events with no registration URL
  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, date, location')
    .is('registration_url', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(50) // Process 50 per run to stay within Brave free tier

  if (!events?.length) {
    console.log('[urlResolver] No events need URL resolution')
    return { processed: 0, suggestions: 0 }
  }

  let totalSuggestions = 0

  for (const event of events) {
    // Check if we already have pending suggestions for this event
    const { count } = await supabase
      .from('url_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('calendar_event_id', event.id)
      .eq('status', 'pending')

    if (count > 0) continue

    const year = new Date(event.date).getFullYear()
    const query = `${event.name} ${year} zapisy rejestracja ${event.location || ''}`
    const results = await searchBrave(query)

    if (results.length > 0) {
      const suggestions = results.map(r => ({
        calendar_event_id: event.id,
        search_query: query,
        search_engine: 'brave',
        rank: r.rank,
        url: r.url,
        page_title: r.page_title,
        snippet: r.snippet,
      }))

      await supabase.from('url_suggestions').insert(suggestions)
      totalSuggestions += suggestions.length
    }

    // Rate limit: ~1 req/sec
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[urlResolver] Processed ${events.length} events, created ${totalSuggestions} suggestions`)
  return { processed: events.length, suggestions: totalSuggestions }
}

export { resolveUrls }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/urlResolver.js
git commit -m "feat: add URL resolver with Brave Search API"
```

---

### Task 20: Scraper orchestrator + cron schedule

**Files:**
- Create: `backend/src/scrapers/index.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Write scrapers/index.js**

```javascript
// backend/src/scrapers/index.js
import { scrape as scrapeMaratonypolskie } from './sources/maratonypolskie.js'
import { scrape as scrapeDostartu } from './sources/dostartu.js'
import { normalizeEvent } from './normalizer.js'
import { upsertEvent } from './dedup.js'
import { resolveUrls } from './urlResolver.js'

const sources = [
  { name: 'maratonypolskie', scrape: scrapeMaratonypolskie },
  { name: 'dostartu', scrape: scrapeDostartu },
]

async function runPipeline() {
  console.log('[pipeline] Starting scrape run...')
  const results = { sources: [], urlResolver: null }

  for (const source of sources) {
    const stats = { source: source.name, found: 0, created: 0, updated: 0, errors: [] }

    try {
      const rawEvents = await source.scrape()
      stats.found = rawEvents.length

      for (const raw of rawEvents) {
        try {
          const normalized = await normalizeEvent(raw)
          if (!normalized) {
            stats.errors.push({ raw: raw.name, message: 'Failed to normalize (no date?)' })
            continue
          }

          const { action, error } = await upsertEvent(normalized)
          if (error) {
            stats.errors.push({ raw: raw.name, message: error.message })
          } else if (action === 'created') {
            stats.created++
          } else {
            stats.updated++
          }
        } catch (err) {
          stats.errors.push({ raw: raw.name, message: err.message })
        }
      }
    } catch (err) {
      stats.errors.push({ raw: null, message: `Source failed: ${err.message}` })
    }

    results.sources.push(stats)
    console.log(`[pipeline] ${source.name}: found=${stats.found} new=${stats.created} updated=${stats.updated} errors=${stats.errors.length}`)
  }

  // URL resolution pass
  results.urlResolver = await resolveUrls()

  console.log('[pipeline] Scrape run complete')
  return results
}

export { runPipeline }
```

- [ ] **Step 2: Create backend/src/routes/scrapers.js**

```javascript
// backend/src/routes/scrapers.js
import { runPipeline } from '../scrapers/index.js'

export async function scrapersRoutes(fastify) {
  fastify.post('/scrapers/run', async (request, reply) => {
    const results = await runPipeline()
    return { data: results }
  })
}
```

- [ ] **Step 3: Add route registration and cron to server.js**

Add imports at top of `backend/src/server.js`:
```javascript
import cron from 'node-cron'
import { scrapersRoutes } from './routes/scrapers.js'
```

Add route registration inside the `fastify.register` block (alongside other routes):
```javascript
await api.register(scrapersRoutes)
```

Add cron schedule inside the `start()` function, after `fastify.listen`:
```javascript
// Run scrapers daily at 03:00
cron.schedule('0 3 * * *', () => {
  console.log('[cron] Starting daily scrape...')
  runPipeline().catch(err => console.error('[cron] Scrape failed:', err))
})
```
Note: import `runPipeline` at the top: `import { runPipeline } from './scrapers/index.js'`

- [ ] **Step 3: Commit**

```bash
git add backend/src/scrapers/index.js backend/src/routes/scrapers.js backend/src/server.js
git commit -m "feat: add scraper orchestrator, route, and cron schedule"
```

---

### Task 21: Calendar events CRUD route (manual entry)

**Files:**
- Create: `backend/src/routes/calendarEvents.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Write calendarEvents.js**

```javascript
// backend/src/routes/calendarEvents.js
import { supabase } from '../lib/supabaseClient.js'

export async function calendarEventsRoutes(fastify) {
  // List calendar events (admin)
  fastify.get('/calendar-events', async (request, reply) => {
    const { page = 1, limit = 50, source } = request.query
    const from = (page - 1) * limit

    let query = supabase
      .from('calendar_events')
      .select('*', { count: 'exact' })
      .order('date', { ascending: true })
      .range(from, from + limit - 1)

    if (source) query = query.eq('source', source)

    const { data, count, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { data, total: count }
  })

  // Create calendar event (manual entry)
  fastify.post('/calendar-events', async (request, reply) => {
    const event = { ...request.body, source: 'manual' }
    const { data, error } = await supabase
      .from('calendar_events')
      .insert(event)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  // Update calendar event
  fastify.patch('/calendar-events/:id', async (request, reply) => {
    const { id } = request.params
    const updates = { ...request.body, updated_at: new Date().toISOString() }

    const { data, error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  // Delete calendar event
  fastify.delete('/calendar-events/:id', async (request, reply) => {
    const { id } = request.params
    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('id', id)

    if (error) return reply.status(400).send({ error: error.message })
    return { success: true }
  })
}
```

- [ ] **Step 2: Register route in server.js**

Add import and registration:
```javascript
import { calendarEventsRoutes } from './routes/calendarEvents.js'
// Inside the api.register block:
await api.register(calendarEventsRoutes)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/calendarEvents.js backend/src/server.js
git commit -m "feat: add calendar events CRUD route for manual entry"
```

---

### Task 22: URL suggestions route

**Files:**
- Create: `backend/src/routes/urlSuggestions.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Write urlSuggestions.js**

```javascript
// backend/src/routes/urlSuggestions.js
import { supabase } from '../lib/supabaseClient.js'

export async function urlSuggestionsRoutes(fastify) {
  // List pending suggestions (grouped by event)
  fastify.get('/url-suggestions', async (request, reply) => {
    const { status = 'pending' } = request.query

    const { data, error } = await supabase
      .from('url_suggestions')
      .select(`
        *,
        calendar_events!inner(id, name, date, location)
      `)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) return reply.status(500).send({ error: error.message })
    return { data }
  })

  // Approve a suggestion
  fastify.post('/url-suggestions/:id/approve', async (request, reply) => {
    const { id } = request.params

    // Get the suggestion
    const { data: suggestion, error: fetchErr } = await supabase
      .from('url_suggestions')
      .select('calendar_event_id, url')
      .eq('id', id)
      .single()

    if (fetchErr) return reply.status(404).send({ error: 'Suggestion not found' })

    // Update suggestion status
    await supabase
      .from('url_suggestions')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', id)

    // Reject other suggestions for same event
    await supabase
      .from('url_suggestions')
      .update({ status: 'rejected', rejection_reason: 'other_approved', reviewed_at: new Date().toISOString() })
      .eq('calendar_event_id', suggestion.calendar_event_id)
      .neq('id', id)
      .eq('status', 'pending')

    // Set the URL on the calendar event
    await supabase
      .from('calendar_events')
      .update({ registration_url: suggestion.url, updated_at: new Date().toISOString() })
      .eq('id', suggestion.calendar_event_id)

    return { data: { approved: true } }
  })

  // Reject a suggestion
  fastify.post('/url-suggestions/:id/reject', async (request, reply) => {
    const { id } = request.params
    const { reason } = request.body || {}

    const { error } = await supabase
      .from('url_suggestions')
      .update({
        status: 'rejected',
        rejection_reason: reason || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (error) return reply.status(400).send({ error: error.message })
    return { data: { rejected: true } }
  })
}
```

- [ ] **Step 2: Register route in server.js**

```javascript
import { urlSuggestionsRoutes } from './routes/urlSuggestions.js'
// Inside the api.register block:
await api.register(urlSuggestionsRoutes)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/urlSuggestions.js backend/src/server.js
git commit -m "feat: add URL suggestions route with approve/reject"
```

---

### Task 23: Admin URL Review page

**Files:**
- Create: `frontend/src/pages/UrlReview.jsx`
- Modify: `frontend/src/App.jsx` (or wherever routes are defined in the admin app)

- [ ] **Step 1: Write UrlReview.jsx**

```jsx
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'

function SuggestionCard({ suggestion, onApprove, onReject }) {
  return (
    <div className="border border-apex-border bg-apex-surface p-4 mb-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-apex-yellow-dim mb-1">#{suggestion.rank}</div>
          <a href={suggestion.url} target="_blank" rel="noopener" className="text-apex-cyan text-sm hover:underline break-all">
            {suggestion.url}
          </a>
          {suggestion.page_title && (
            <div className="text-sm text-apex-text-bright mt-1 font-semibold">{suggestion.page_title}</div>
          )}
          {suggestion.snippet && (
            <div className="text-xs text-apex-muted mt-1 line-clamp-2">{suggestion.snippet}</div>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={() => onApprove(suggestion.id)}
            className="px-4 py-2 bg-apex-yellow text-apex-bg font-display font-bold text-xs tracking-wider uppercase hover:shadow-[0_0_12px_rgba(187,221,0,0.3)]">
            Zatwierdz
          </button>
          <button onClick={() => onReject(suggestion.id)}
            className="px-4 py-2 border border-apex-red text-apex-red font-display font-bold text-xs tracking-wider uppercase hover:bg-apex-red hover:text-white">
            Odrzuc
          </button>
        </div>
      </div>
    </div>
  )
}

export default function UrlReview() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['url-suggestions'],
    queryFn: () => api.get('/url-suggestions?status=pending').then(r => r.data),
  })

  const approveMutation = useMutation({
    mutationFn: (id) => api.post(`/url-suggestions/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries(['url-suggestions']),
  })

  const rejectMutation = useMutation({
    mutationFn: (id) => api.post(`/url-suggestions/${id}/reject`),
    onSuccess: () => queryClient.invalidateQueries(['url-suggestions']),
  })

  // Group suggestions by event
  const grouped = (data || []).reduce((acc, s) => {
    const eventId = s.calendar_events?.id || s.calendar_event_id
    if (!acc[eventId]) {
      acc[eventId] = {
        event: s.calendar_events || { name: 'Unknown', date: '', location: '' },
        suggestions: [],
      }
    }
    acc[eventId].suggestions.push(s)
    return acc
  }, {})

  return (
    <div className="p-6">
      <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-2">
        Weryfikacja linkow
      </h1>
      <p className="text-apex-muted text-sm mb-8">
        Zatwierdz lub odrzuc sugerowane linki do zapisow dla wydarzen bez URL.
      </p>

      {isLoading && <div className="text-apex-muted">Ladowanie...</div>}

      {Object.entries(grouped).map(([eventId, { event, suggestions }]) => (
        <div key={eventId} className="mb-8">
          <div className="mb-3">
            <div className="font-display font-bold text-lg tracking-wide uppercase text-apex-text-bright">{event.name}</div>
            <div className="text-xs text-apex-muted">{event.date} &middot; {event.location}</div>
          </div>
          {suggestions.sort((a, b) => a.rank - b.rank).map(s => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onApprove={(id) => approveMutation.mutate(id)}
              onReject={(id) => rejectMutation.mutate(id)}
            />
          ))}
        </div>
      ))}

      {!isLoading && Object.keys(grouped).length === 0 && (
        <div className="text-apex-muted text-center py-12">Brak oczekujacych sugestii.</div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add route to frontend admin app**

In the frontend app's router file, add:
```jsx
import UrlReview from './pages/UrlReview.jsx'
// Add route:
<Route path="/url-review" element={<UrlReview />} />
```

Also add a nav link in the admin Navbar component to `/url-review`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/UrlReview.jsx frontend/src/App.jsx
git commit -m "feat: add admin URL review page with approve/reject"
```

---

### Task 24: Admin Calendar Event Form page

**Files:**
- Create: `frontend/src/pages/CalendarEventForm.jsx`

- [ ] **Step 1: Write CalendarEventForm.jsx**

```jsx
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api.js'

const EMPTY_EVENT = {
  name: '', date: '', location: '', voivodeship: '',
  event_type: [], distances: '', description: '',
  registration_url: '', organizer: '', website: '',
  is_night: false, is_charity: false,
}

export default function CalendarEventForm() {
  const [form, setForm] = useState(EMPTY_EVENT)
  const [success, setSuccess] = useState(null)

  const mutation = useMutation({
    mutationFn: (data) => api.post('/calendar-events', data),
    onSuccess: () => {
      setSuccess('Wydarzenie dodane!')
      setForm(EMPTY_EVENT)
      setTimeout(() => setSuccess(null), 3000)
    },
  })

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const handleSubmit = (e) => {
    e.preventDefault()
    const data = {
      ...form,
      distances: form.distances ? form.distances.split(',').map(d => d.trim()) : [],
      distances_meters: form.distances
        ? form.distances.split(',').map(d => Math.round(parseFloat(d.trim()) * 1000))
        : [],
    }
    mutation.mutate(data)
  }

  const inputClass = "w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm py-2.5 px-3 outline-none focus:border-apex-yellow-dim"

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-2">
        Dodaj wydarzenie
      </h1>
      <p className="text-apex-muted text-sm mb-8">
        Recznie dodaj wydarzenie do kalendarza (np. znalezione na Facebook).
      </p>

      {success && <div className="bg-apex-yellow/10 border border-apex-yellow/20 text-apex-yellow px-4 py-3 mb-6 text-sm">{success}</div>}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Nazwa *</label>
          <input required value={form.name} onChange={e => update('name', e.target.value)} className={inputClass} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Data *</label>
            <input required type="date" value={form.date} onChange={e => update('date', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Miejscowosc</label>
            <input value={form.location} onChange={e => update('location', e.target.value)} className={inputClass} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Wojewodztwo</label>
            <input value={form.voivodeship} onChange={e => update('voivodeship', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Dystanse (km, po przecinku)</label>
            <input value={form.distances} onChange={e => update('distances', e.target.value)} placeholder="5, 10, 21.1" className={inputClass} />
          </div>
        </div>
        <div>
          <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">URL zapisow</label>
          <input type="url" value={form.registration_url} onChange={e => update('registration_url', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Organizator</label>
          <input value={form.organizer} onChange={e => update('organizer', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Opis</label>
          <textarea value={form.description} onChange={e => update('description', e.target.value)} rows={3} className={inputClass} />
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm text-apex-text cursor-pointer">
            <input type="checkbox" checked={form.is_night} onChange={e => update('is_night', e.target.checked)} />
            Bieg nocny
          </label>
          <label className="flex items-center gap-2 text-sm text-apex-text cursor-pointer">
            <input type="checkbox" checked={form.is_charity} onChange={e => update('is_charity', e.target.checked)} />
            Charytatywny
          </label>
        </div>

        <button type="submit" disabled={mutation.isPending}
          className="font-display font-bold text-sm tracking-widest uppercase py-3 px-8 bg-apex-yellow text-apex-bg hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all disabled:opacity-50 self-start">
          {mutation.isPending ? 'Dodawanie...' : 'Dodaj wydarzenie'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Add route to frontend admin app**

```jsx
import CalendarEventForm from './pages/CalendarEventForm.jsx'
// Add route:
<Route path="/calendar-events/new" element={<CalendarEventForm />} />
```

Add nav link in admin Navbar.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/CalendarEventForm.jsx frontend/src/App.jsx
git commit -m "feat: add admin calendar event form for manual entry"
```

---

### CHECKPOINT: Phase 3 Complete

- [ ] `POST /api/scrapers/run` triggers the full pipeline
- [ ] Scraper skeletons are in place (selectors need real HTML inspection)
- [ ] Normalizer parses dates, distances, and event types
- [ ] Dedup matches across sources by name similarity + date
- [ ] URL resolver searches Brave and stores suggestions
- [ ] Admin URL review page shows pending suggestions with approve/reject
- [ ] Admin calendar event form allows manual entry
- [ ] Cron runs daily at 03:00

---

## Post-Implementation Notes

1. **Scraper selectors** — Tasks 17 and 18 are skeletons. The implementer must visit the actual websites, inspect their HTML, and fill in the correct CSS selectors. Run `POST /api/scrapers/run` after fixing selectors to test.

2. **Distance filtering** — The Supabase `overlaps` query in Kalendarz.jsx Task 12 is a simplification. A more robust approach: create a Supabase RPC function that checks if any value in `distances_meters` falls within the range.

3. **Leaflet CSS** — Leaflet requires its CSS to be loaded. The import `'leaflet/dist/leaflet.css'` in MapView.jsx should work with Vite, but verify it renders correctly.

4. **Logo** — `public/public/logo-bez-napisu.svg` must be the version with green leaves (already copied in the brainstorming phase). Verify it's the correct file before deploying.
