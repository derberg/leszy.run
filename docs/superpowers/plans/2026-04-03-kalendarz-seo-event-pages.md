# Kalendarz SEO — Event Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add individual event pages at `/kalendarz/:slug` with per-event SEO, static OG images, and a build-time sitemap so every calendar event is indexable and shareable.

**Architecture:** A shared `slugify()` utility generates URL slugs from event name+date. The publish script (`run-publish.js`) queries Supabase, writes a manifest + OG images to `public/kalendarz/`. The Vercel post-build script reads the manifest to generate per-event HTML files + sitemap into `dist/`. The SPA renders `EventPage` using embedded data (direct hit) or a Supabase fallback (SPA navigation).

**Tech Stack:** React 19, React Router 7, Supabase JS, sharp (OG images), Leaflet (map), Tailwind v4 with OVERDRIVE theme

**Spec:** `docs/superpowers/specs/2026-04-03-kalendarz-seo-event-pages-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `public/src/lib/slugify.js` | Shared slug generation (Polish diacritics, date suffix) |
| `public/src/pages/EventPage.jsx` | Individual event page component |
| `public/src/components/EventInfoGrid.jsx` | Adaptive 2-column info grid |
| `public/src/components/EventMap.jsx` | Single-pin Leaflet map |
| `public/src/components/NearbyEvents.jsx` | "W okolicy tego weekendu" section |
| `public/scripts/generate-event-pages.js` | Post-vite-build: manifest → HTML + sitemap into `dist/` |
| `public/scripts/generate-event-og.js` | OG image generation for a single event (used by publish script) |
| `backend/scripts/publish-event-pages.js` | Post-publish: Supabase → manifest + OG images |

### Modified files
| File | Change |
|------|--------|
| `public/src/App.jsx` | Add `/kalendarz/:slug` route |
| `public/src/components/EventRow.jsx` | Change click to internal SPA navigation |
| `public/package.json` | Update `build` script to run post-build generator |
| `public/public/sitemap.xml` | Deleted (replaced by build-time generation) |

---

### Task 1: Slugify utility

**Files:**
- Create: `public/src/lib/slugify.js`

This is the foundation — used by EventRow, EventPage, publish script, and build script. Must be importable from both browser (ESM) and Node.js (scripts).

- [ ] **Step 1: Create the slugify function**

```js
// public/src/lib/slugify.js

const POLISH_MAP = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
  'Ą': 'a', 'Ć': 'c', 'Ę': 'e', 'Ł': 'l', 'Ń': 'n',
  'Ó': 'o', 'Ś': 's', 'Ź': 'z', 'Ż': 'z',
}

/**
 * Generate a URL-safe slug from event name and date.
 * @param {string} name - Event name
 * @param {string} date - ISO date string (YYYY-MM-DD)
 * @param {string} [id] - Optional event ID for dedup suffix
 * @returns {string} slug like "bieg-7-szczytow-ultra-trail-2026-07-12"
 */
export function slugify(name, date, id) {
  const base = name
    .toLowerCase()
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, ch => POLISH_MAP[ch] || ch)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const dateStr = date.slice(0, 10) // YYYY-MM-DD
  const slug = `${base}-${dateStr}`

  return id ? `${slug}-${id.slice(0, 4)}` : slug
}

/**
 * Extract the date portion from a slug (last 10 chars before optional ID suffix).
 * @param {string} slug
 * @returns {string|null} ISO date string or null
 */
export function extractDateFromSlug(slug) {
  // Match YYYY-MM-DD pattern anywhere in slug
  const match = slug.match(/(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}
```

- [ ] **Step 2: Verify it works with edge cases**

Test mentally (or in Node REPL):
- `slugify("Bieg 7 Szczytów Ultra Trail", "2026-07-12")` → `"bieg-7-szczytow-ultra-trail-2026-07-12"`
- `slugify("V Bieg Konstytucji 3 Maja", "2026-05-03")` → `"v-bieg-konstytucji-3-maja-2026-05-03"`
- `slugify("  Bieg!!! Z @#$ Okazji  ", "2026-01-01")` → `"bieg-z-okazji-2026-01-01"`
- `extractDateFromSlug("bieg-7-szczytow-ultra-trail-2026-07-12")` → `"2026-07-12"`
- `extractDateFromSlug("bieg-xyz-2026-05-03-a3f2")` → `"2026-05-03"`

- [ ] **Step 3: Commit**

```bash
git add public/src/lib/slugify.js
git commit -m "feat: add slugify utility for calendar event URLs"
```

---

### Task 2: EventPage component

**Files:**
- Create: `public/src/pages/EventPage.jsx`
- Create: `public/src/components/EventInfoGrid.jsx`
- Create: `public/src/components/EventMap.jsx`
- Create: `public/src/components/NearbyEvents.jsx`

**Docs to check:**
- `public/src/app.css` for theme tokens (`apex-*` classes)
- `public/src/components/EventRow.jsx` for tag styling patterns (TypeTag, DistTag)
- `public/src/components/ReportEventModal.jsx` for report button integration
- `public/src/hooks/useSeo.js` for SEO hook API

- [ ] **Step 1: Create EventInfoGrid component**

The adaptive 2-column grid that only renders cells with data.

```jsx
// public/src/components/EventInfoGrid.jsx

function formatDatePolish(dateStr, endDateStr) {
  const opts = { day: 'numeric', month: 'long', year: 'numeric' }
  const start = new Date(dateStr).toLocaleDateString('pl-PL', opts)
  if (!endDateStr) return start
  const end = new Date(endDateStr).toLocaleDateString('pl-PL', opts)
  return `${start} — ${end}`
}

function formatPrice(from, to) {
  if (!from && !to) return null
  if (from && to) return `od ${from} zł do ${to} zł`
  if (from) return `od ${from} zł`
  return `do ${to} zł`
}

function formatDeadline(dateStr) {
  if (!dateStr) return null
  return `do ${new Date(dateStr).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
}

function formatElevation(m) {
  if (!m) return null
  return `${Number(m).toLocaleString('pl-PL')} m`
}

export default function EventInfoGrid({ event }) {
  const cells = [
    { label: 'Data', value: formatDatePolish(event.date, event.end_date) },
    { label: 'Lokalizacja', value: [event.location, event.voivodeship].filter(Boolean).join(', ') },
  ]

  if (event.distances?.length) {
    cells.push({ label: 'Dystanse', value: event.distances.join(' / ') })
  }

  const price = formatPrice(event.price_from, event.price_to)
  if (price) cells.push({ label: 'Cena', value: price, accent: true })

  const deadline = formatDeadline(event.registration_deadline)
  if (deadline) cells.push({ label: 'Termin zapisów', value: deadline, accent: true })

  if (event.max_participants) cells.push({ label: 'Max. uczestników', value: String(event.max_participants) })
  if (event.elevation_gain_m) cells.push({ label: 'Przewyższenie', value: formatElevation(event.elevation_gain_m) })
  if (event.surface) cells.push({ label: 'Nawierzchnia', value: event.surface })

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 border border-apex-border mb-8">
      {cells.map((cell, i) => {
        const isLast = i === cells.length - 1
        const isOddTotal = cells.length % 2 !== 0
        const spanFull = isLast && isOddTotal

        return (
          <div
            key={cell.label}
            className={`px-5 py-4 border-b border-apex-border ${
              !spanFull && i % 2 === 0 ? 'sm:border-r' : ''
            } ${spanFull ? 'sm:col-span-2' : ''}`}
          >
            <div className="font-mono text-[10px] font-semibold tracking-[2px] uppercase text-apex-dim mb-1">
              {cell.label}
            </div>
            <div className={`font-sans text-base font-semibold ${cell.accent ? 'text-apex-yellow' : 'text-apex-text-bright'}`}>
              {cell.value}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Create EventMap component**

Single-pin Leaflet map. Lazy-loaded since Leaflet is heavy.

```jsx
// public/src/components/EventMap.jsx
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'

// Fix default marker icon (Leaflet + bundler issue)
const pin = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
})

export default function EventMap({ lat, lng, name }) {
  if (!lat || !lng) return null

  return (
    <div className="border border-apex-border mb-8 h-[220px]">
      <MapContainer
        center={[Number(lat), Number(lng)]}
        zoom={12}
        scrollWheelZoom={false}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[Number(lat), Number(lng)]} icon={pin}>
          <Popup>{name}</Popup>
        </Marker>
      </MapContainer>
    </div>
  )
}
```

- [ ] **Step 3: Create NearbyEvents component**

Fetches nearby events from Supabase (same voivodeship, ±3 days).

```jsx
// public/src/components/NearbyEvents.jsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { slugify } from '../lib/slugify.js'

export default function NearbyEvents({ event }) {
  const [nearby, setNearby] = useState([])

  useEffect(() => {
    if (!event.voivodeship || !event.date) return

    const date = new Date(event.date)
    const from = new Date(date)
    from.setDate(from.getDate() - 3)
    const to = new Date(date)
    to.setDate(to.getDate() + 3)

    const fromStr = from.toISOString().slice(0, 10)
    const toStr = to.toISOString().slice(0, 10)

    supabase
      .from('calendar_events')
      .select('id, name, date, location, distances, voivodeship')
      .eq('status', 'active')
      .eq('voivodeship', event.voivodeship)
      .gte('date', fromStr)
      .lte('date', toStr)
      .neq('id', event.id)
      .order('date', { ascending: true })
      .limit(5)
      .then(({ data }) => {
        if (data?.length) setNearby(data)
      })
  }, [event.id, event.voivodeship, event.date])

  if (nearby.length === 0) return null

  return (
    <div className="mb-8">
      <h2 className="font-display font-bold text-lg tracking-[3px] uppercase text-apex-text-bright mb-4 pb-2 border-b border-apex-border">
        W okolicy tego weekendu
      </h2>
      {nearby.map(ev => {
        const dateStr = new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })
        const distLabel = ev.distances?.length ? ev.distances.join(' / ') : null
        const slug = slugify(ev.name, ev.date)

        return (
          <Link
            key={ev.id}
            to={`/kalendarz/${slug}`}
            className="grid grid-cols-[70px_1fr_auto] items-center gap-4 py-3 border-b border-apex-border hover:bg-apex-surface transition-colors no-underline"
          >
            <span className="font-mono text-xs font-semibold text-apex-yellow">{dateStr}</span>
            <div className="min-w-0">
              <div className="font-display font-bold text-[15px] tracking-wide uppercase text-apex-text-bright truncate">
                {ev.name}
              </div>
              <div className="text-xs text-apex-muted">{ev.location}</div>
            </div>
            {distLabel && (
              <span className="font-mono text-[10px] text-apex-yellow-dim border border-[rgba(187,221,0,0.2)] px-2 py-0.5 flex-shrink-0">
                {distLabel}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Create EventPage component**

The main page. Reads embedded data (static HTML hit) or fetches from Supabase (SPA navigation).

```jsx
// public/src/pages/EventPage.jsx
import { useState, useEffect, lazy, Suspense } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { slugify, extractDateFromSlug } from '../lib/slugify.js'
import useSeo from '../hooks/useSeo.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import EventInfoGrid from '../components/EventInfoGrid.jsx'
import NearbyEvents from '../components/NearbyEvents.jsx'
import ReportEventModal from '../components/ReportEventModal.jsx'
import useTheme from '../hooks/useTheme.js'

const EventMap = lazy(() => import('../components/EventMap.jsx'))

const TYPE_LABELS = {
  trail: 'trail', nocny: 'nocny', ocr: 'OCR', nordic: 'nordic walking',
  ultra: 'ultramaraton', charytatywny: 'charytatywny', uliczny: 'uliczny',
}

const baseTag = 'font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border uppercase'

function TypeTag({ label }) {
  const colors = label === 'nocny'
    ? 'border-[rgba(148,130,220,0.3)] text-[#9482dc]'
    : label === 'charytatywny'
    ? 'border-[rgba(45,90,39,0.5)] text-[#5baa52]'
    : 'border-apex-cyan/30 text-apex-cyan'
  return <span className={`${baseTag} ${colors}`}>{TYPE_LABELS[label] || label}</span>
}

function DistTag({ label }) {
  return <span className={`${baseTag} border-[rgba(187,221,0,0.3)] text-apex-yellow-dim`}>{label}</span>
}

function getEmbeddedData() {
  try {
    const el = document.getElementById('event-data')
    if (!el) return null
    return JSON.parse(el.textContent)
  } catch { return null }
}

function buildCountdown(dateStr) {
  const ms = new Date(dateStr + 'T08:00:00') - new Date()
  if (ms <= 0) return null
  const days = Math.floor(ms / 86400000)
  if (days === 0) return 'Dziś!'
  if (days === 1) return 'Jutro!'
  return `za ${days} dni`
}

function formatDateBadge(date, endDate) {
  const fmt = (d) => new Date(d).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  if (!endDate) return fmt(date)
  return `${fmt(date)} — ${fmt(endDate)}`
}

function buildDescription(event) {
  const parts = []
  const date = new Date(event.date).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })
  parts.push(date)
  if (event.location) parts.push(event.location)
  if (event.distances?.length) parts.push(event.distances.join(' / '))
  const types = (event.event_type || []).filter(t => t !== 'bieg').map(t => TYPE_LABELS[t] || t)
  if (types.length) parts.push(types.join(', '))
  return parts.join(' · ')
}

function buildJsonLd(event, slug) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: event.name,
    startDate: event.date,
    url: `https://leszy.run/kalendarz/${slug}`,
    location: {
      '@type': 'Place',
      name: event.location || event.voivodeship || 'Polska',
      address: {
        '@type': 'PostalAddress',
        addressRegion: event.voivodeship || undefined,
        addressCountry: 'PL',
      },
    },
  }

  if (event.end_date) ld.endDate = event.end_date

  if (event.lat && event.lng) {
    ld.location.geo = {
      '@type': 'GeoCoordinates',
      latitude: Number(event.lat),
      longitude: Number(event.lng),
    }
  }

  if (event.price_from) {
    ld.offers = {
      '@type': 'AggregateOffer',
      lowPrice: Number(event.price_from),
      priceCurrency: 'PLN',
      availability: 'https://schema.org/InStock',
    }
    if (event.price_to) ld.offers.highPrice = Number(event.price_to)
    if (event.registration_url) ld.offers.url = event.registration_url
  }

  return ld
}

export default function EventPage() {
  const { slug } = useParams()
  const [event, setEvent] = useState(() => getEmbeddedData())
  const [loading, setLoading] = useState(!event)
  const [notFound, setNotFound] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const { isDark } = useTheme()

  // SPA navigation fallback — fetch from Supabase
  useEffect(() => {
    if (event) return

    const date = extractDateFromSlug(slug)
    if (!date) { setNotFound(true); setLoading(false); return }

    supabase
      .from('calendar_events')
      .select('*')
      .eq('status', 'active')
      .eq('date', date)
      .then(({ data }) => {
        if (!data?.length) { setNotFound(true); setLoading(false); return }
        const match = data.find(ev => slugify(ev.name, ev.date) === slug)
          || data.find(ev => slug.startsWith(slugify(ev.name, ev.date)))
        if (match) {
          setEvent(match)
        } else {
          setNotFound(true)
        }
        setLoading(false)
      })
  }, [slug, event])

  const countdown = event ? buildCountdown(event.date) : null
  const description = event ? buildDescription(event) : ''
  const jsonLd = event ? buildJsonLd(event, slug) : null

  useSeo(event ? {
    title: `${event.name} — ${formatDateBadge(event.date, null)} — ${event.location || ''}`,
    description,
    path: `/kalendarz/${slug}`,
    image: `https://leszy.run/kalendarz/${slug}/og.png`,
    jsonLd,
  } : {})

  if (loading) {
    return (
      <>
        <Navbar />
        <main id="main-content" className="pt-20 pb-16 px-6 max-w-[900px] mx-auto">
          <div className="text-apex-muted animate-pulse">Ładowanie...</div>
        </main>
      </>
    )
  }

  if (notFound || !event) {
    return (
      <>
        <Navbar />
        <main id="main-content" className="pt-20 pb-16 px-6 max-w-[900px] mx-auto text-center">
          <h1 className="font-display font-extrabold text-3xl tracking-wider uppercase text-apex-text-bright mb-4">
            Nie znaleziono wydarzenia
          </h1>
          <Link to="/kalendarz" className="text-apex-cyan no-underline hover:underline">
            &larr; Wróć do kalendarza
          </Link>
        </main>
        <Footer />
      </>
    )
  }

  const types = (event.event_type || []).filter(t => t !== 'bieg')

  return (
    <>
      <Navbar />
      <main id="main-content" className="relative">
        {/* Background logo */}
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0" aria-hidden="true">
          <img
            src="/logo-bez-napisu.svg"
            alt=""
            className={`w-[80vh] max-w-[90vw] h-auto ${isDark ? 'opacity-[0.04]' : 'opacity-[0.06]'}`}
            style={{ filter: isDark
              ? 'brightness(1.4) drop-shadow(0 0 20px rgba(45,90,39,0.6)) drop-shadow(0 0 50px rgba(45,90,39,0.4)) drop-shadow(0 0 80px rgba(187,221,0,0.15))'
              : 'drop-shadow(0 0 20px rgba(45,90,39,0.1))'
            }}
          />
        </div>

        <div className="pt-20 pb-16 px-6 max-w-[900px] mx-auto relative z-10">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-2 font-mono text-[11px] font-semibold tracking-wide uppercase text-apex-dim mb-6">
            <Link to="/kalendarz" className="text-apex-yellow-dim no-underline hover:text-apex-yellow transition-colors">
              Kalendarz
            </Link>
            <span className="text-apex-border-bright">/</span>
            <span className="truncate">{event.name}</span>
          </nav>

          {/* Date badge */}
          <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-apex-yellow mb-3">
            <span>{formatDateBadge(event.date, event.end_date)}</span>
            {countdown && (
              <span className="text-[11px] text-apex-cyan px-2 py-0.5 border border-apex-cyan/30 tracking-wide">
                {countdown}
              </span>
            )}
          </div>

          {/* Title */}
          <h1 className="font-display font-extrabold text-3xl md:text-[42px] tracking-[3px] uppercase text-apex-text-bright leading-tight mb-2">
            {event.name}
          </h1>

          {/* Location */}
          {event.location && (
            <div className="flex items-center gap-1.5 text-base text-apex-muted mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
              </svg>
              {[event.location, event.voivodeship].filter(Boolean).join(', ')}
            </div>
          )}

          {/* Tags */}
          {(types.length > 0 || event.distances?.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mb-7">
              {types.map(t => <TypeTag key={t} label={t} />)}
              {event.distances?.map(d => <DistTag key={d} label={d} />)}
            </div>
          )}

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            {event.registration_url && (
              <a href={event.registration_url} target="_blank" rel="noopener"
                className="font-display font-bold text-sm tracking-[3px] uppercase px-7 py-3 border-2 border-apex-yellow bg-apex-yellow text-apex-ink no-underline hover:bg-apex-yellow-bright hover:border-apex-yellow-bright transition-all text-center">
                Zapisy &rarr;
              </a>
            )}
            {event.website && (
              <a href={event.website} target="_blank" rel="noopener"
                className="font-display font-bold text-sm tracking-[3px] uppercase px-7 py-3 border-2 border-apex-border-bright text-apex-text no-underline hover:border-apex-text hover:text-apex-text-bright transition-all text-center">
                Strona wydarzenia
              </a>
            )}
            {event.regulamin_url && (
              <a href={event.regulamin_url} target="_blank" rel="noopener"
                className="font-display font-bold text-sm tracking-[3px] uppercase px-7 py-3 border-2 border-apex-border-bright text-apex-text no-underline hover:border-apex-text hover:text-apex-text-bright transition-all text-center">
                Regulamin
              </a>
            )}
          </div>

          {/* Info Grid */}
          <EventInfoGrid event={event} />

          {/* Map */}
          <Suspense fallback={<div className="h-[220px] border border-apex-border mb-8 bg-apex-surface" />}>
            <EventMap lat={event.lat} lng={event.lng} name={event.name} />
          </Suspense>

          {/* Report */}
          <div className="flex justify-end mb-12">
            <button
              onClick={() => setShowReport(true)}
              className="font-mono text-[11px] font-semibold tracking-wide text-apex-dim hover:text-apex-text transition-colors flex items-center gap-1.5 bg-transparent border-none cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
              Zgłoś poprawkę
            </button>
          </div>

          {/* Nearby Events */}
          <NearbyEvents event={event} />
        </div>
      </main>

      {showReport && <ReportEventModal event={event} onClose={() => setShowReport(false)} />}
      <Footer />
    </>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add public/src/pages/EventPage.jsx public/src/components/EventInfoGrid.jsx public/src/components/EventMap.jsx public/src/components/NearbyEvents.jsx
git commit -m "feat: add EventPage with info grid, map, and nearby events"
```

---

### Task 3: Router and EventRow navigation

**Files:**
- Modify: `public/src/App.jsx:9,34` (add lazy import + route)
- Modify: `public/src/components/EventRow.jsx:42-48` (change click handler)

- [ ] **Step 1: Add route in App.jsx**

Add lazy import after line 10 (`DodajWydarzenie`):

```js
const EventPage = lazy(() => import('./pages/EventPage.jsx'))
```

Add route before the `/kalendarz` route (more specific path must come first). Insert between the `/kalendarz/dodaj` route and the `/kalendarz` route:

```jsx
<Route path="/kalendarz/:slug" element={<EventPage />} />
```

The routes section should look like:
```jsx
<Route path="/kalendarz/dodaj" element={<DodajWydarzenie />} />
<Route path="/kalendarz/:slug" element={<EventPage />} />
<Route path="/kalendarz" element={<Kalendarz />} />
```

- [ ] **Step 2: Update EventRow click to navigate internally**

In `public/src/components/EventRow.jsx`, add imports at the top:

```js
import { useNavigate } from 'react-router-dom'
import { slugify } from '../lib/slugify.js'
```

Inside the `EventRow` component, add:
```js
const navigate = useNavigate()
```

Replace the `handleClick` function (lines 42-48) with:

```js
const handleClick = () => {
  if (isLeszyrun && event.slug) {
    window.location.href = `/events/${event.slug}`
  } else {
    navigate(`/kalendarz/${slugify(event.name, event.date)}`)
  }
}
```

This removes the external URL opening — users now land on the event page where registration is the CTA.

- [ ] **Step 3: Test manually**

Run `cd public && npx vite --port 3002`, open `http://localhost:3002/kalendarz`, click on any event. Should navigate to `/kalendarz/{slug}` and show the event page via Supabase fallback query. Back button should return to the calendar.

- [ ] **Step 4: Commit**

```bash
git add public/src/App.jsx public/src/components/EventRow.jsx
git commit -m "feat: route EventRow clicks to internal event pages"
```

---

### Task 4: Publish script — manifest + OG images

**Files:**
- Create: `public/scripts/generate-event-og.js`
- Create: `backend/scripts/publish-event-pages.js`

**Docs to check:**
- `public/scripts/generate-og-image.js` for sharp SVG→PNG pattern
- `public/src/lib/slugify.js` for slug generation (copy the function since Node scripts can't use ESM import from the SPA easily — duplicate the small function)

- [ ] **Step 1: Create OG image generator**

This module exports a function that generates a single event OG image using sharp.

```js
// public/scripts/generate-event-og.js
import sharp from 'sharp'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const WIDTH = 1200
const HEIGHT = 630
const CX = WIDTH / 2

// Light theme colors (matches app.css html.light)
const BG = '#F5F5F8'
const YELLOW = '#6B8000'
const GREEN = '#2D5A27'
const TEXT_BRIGHT = '#1A1830'
const TEXT_MUTED = '#6B6980'
const BORDER = '#DCDCE8'
const CYAN = '#0891B2'

const TYPE_LABELS = {
  trail: 'TRAIL', nocny: 'NOCNY', ocr: 'OCR', nordic: 'NORDIC',
  ultra: 'ULTRA', charytatywny: 'CHARITY', uliczny: 'ULICZNY',
}

const POLISH_MONTHS = [
  'STYCZNIA', 'LUTEGO', 'MARCA', 'KWIETNIA', 'MAJA', 'CZERWCA',
  'LIPCA', 'SIERPNIA', 'WRZEŚNIA', 'PAŹDZIERNIKA', 'LISTOPADA', 'GRUDNIA',
]

function formatDatePolish(dateStr) {
  const d = new Date(dateStr)
  return `${d.getDate()} ${POLISH_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

const logoPath = resolve(ROOT, 'public/logo-bez-napisu.svg')
const logoSvg = readFileSync(logoPath, 'utf-8')

/**
 * Generate an OG image for a calendar event.
 * @param {Object} event - Event data from manifest
 * @param {string} outputPath - Absolute path to write the PNG
 */
export async function generateEventOg(event, outputPath) {
  const name = escapeXml(truncate(event.name.toUpperCase(), 50))
  const dateText = formatDatePolish(event.date)
  const location = escapeXml(truncate(
    [event.location, event.voivodeship].filter(Boolean).join(', '),
    60
  ))
  const types = (event.event_type || []).filter(t => t !== 'bieg')
  const distances = (event.distances || []).slice(0, 5)

  // Build type + distance badges as SVG text
  let badgeX = CX - ((types.length + distances.length) * 45)
  if (badgeX < 60) badgeX = 60
  let badgeSvg = ''
  let bx = badgeX

  for (const t of types) {
    const label = TYPE_LABELS[t] || t.toUpperCase()
    badgeSvg += `<text x="${bx}" y="480" font-family="Arial, sans-serif" font-weight="700" font-size="14" letter-spacing="2" fill="${CYAN}">${escapeXml(label)}</text>`
    bx += label.length * 11 + 20
  }
  for (const d of distances) {
    badgeSvg += `<text x="${bx}" y="480" font-family="Arial, sans-serif" font-weight="700" font-size="14" letter-spacing="2" fill="${YELLOW}">${escapeXml(d)}</text>`
    bx += d.length * 10 + 20
  }

  const svgImage = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="30%" r="45%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="${WIDTH}" height="4" fill="${YELLOW}"/>

  <!-- Event name -->
  <text x="${CX}" y="320"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="800"
    font-size="52" letter-spacing="4" text-anchor="middle" fill="${TEXT_BRIGHT}">
    ${name}
  </text>

  <!-- Date -->
  <text x="${CX}" y="375"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="600"
    font-size="26" letter-spacing="4" text-anchor="middle" fill="${YELLOW}">
    ${dateText}
  </text>

  <!-- Location -->
  <text x="${CX}" y="420"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="20" letter-spacing="2" text-anchor="middle" fill="${TEXT_MUTED}">
    ${location}
  </text>

  <!-- Badges -->
  ${badgeSvg}

  <!-- Bottom bar -->
  <line x1="0" y1="${HEIGHT - 50}" x2="${WIDTH}" y2="${HEIGHT - 50}" stroke="${BORDER}" stroke-width="1"/>
  <text x="60" y="${HEIGHT - 20}"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="14" letter-spacing="3" fill="${TEXT_MUTED}" opacity="0.5">
    leszy.run/kalendarz
  </text>

  <!-- Bottom accent -->
  <rect x="0" y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${YELLOW}" opacity="0.4"/>
</svg>`

  const LOGO_H = 200
  const logoBuffer = await sharp(Buffer.from(logoSvg))
    .resize({ height: LOGO_H, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  const logoMeta = await sharp(logoBuffer).metadata()
  const logoW = logoMeta.width || LOGO_H
  const logoX = Math.round((WIDTH - logoW) / 2)

  const baseBuffer = await sharp(Buffer.from(svgImage))
    .resize(WIDTH, HEIGHT)
    .png()
    .toBuffer()

  const output = await sharp(baseBuffer)
    .composite([{ input: logoBuffer, left: logoX, top: 40, blend: 'over' }])
    .png({ quality: 85, compressionLevel: 9 })
    .toBuffer()

  await sharp(output).toFile(outputPath)
  return output.length
}
```

- [ ] **Step 2: Create publish-event-pages script**

This script is run locally after scraper pipeline. It queries Supabase, updates the manifest, and generates OG images for new events.

```js
// backend/scripts/publish-event-pages.js
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { generateEventOg } from '../../public/scripts/generate-event-og.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, '../../public/public')
const KALENDARZ_DIR = resolve(PUBLIC_DIR, 'kalendarz')
const MANIFEST_PATH = resolve(KALENDARZ_DIR, '.manifest.json')

// Usage: cd backend && node --env-file=../.env scripts/publish-event-pages.js [--apply]
const dryRun = !process.argv.includes('--apply')
if (dryRun) console.log('=== DRY RUN (use --apply to write files) ===\n')

// Inline slugify (same logic as public/src/lib/slugify.js)
const POLISH_MAP = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
  'Ą': 'a', 'Ć': 'c', 'Ę': 'e', 'Ł': 'l', 'Ń': 'n',
  'Ó': 'o', 'Ś': 's', 'Ź': 'z', 'Ż': 'z',
}

function slugify(name, date) {
  const base = name
    .toLowerCase()
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, ch => POLISH_MAP[ch] || ch)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${base}-${date.slice(0, 10)}`
}

// Fields to store in manifest (subset of calendar_events)
const MANIFEST_FIELDS = [
  'id', 'name', 'date', 'end_date', 'location', 'voivodeship', 'lat', 'lng',
  'distances', 'event_type', 'registration_url', 'website', 'regulamin_url',
  'price_from', 'price_to', 'registration_deadline', 'max_participants',
  'elevation_gain_m', 'surface', 'is_night', 'is_charity', 'is_kids',
]

function pick(obj, keys) {
  const out = {}
  for (const k of keys) { if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k] }
  return out
}

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY,
  )

  // Load existing manifest
  let oldManifest = {}
  if (existsSync(MANIFEST_PATH)) {
    oldManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  }

  // Fetch all active events
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select(MANIFEST_FIELDS.join(','))
    .eq('status', 'active')
    .order('date', { ascending: true })

  if (error) { console.error('Supabase error:', error.message); process.exit(1) }
  console.log(`Fetched ${events.length} active events`)

  // Build new manifest
  const newManifest = {}
  const slugCounts = {}

  for (const ev of events) {
    let slug = slugify(ev.name, ev.date)
    // Handle duplicate slugs
    if (newManifest[slug]) {
      slug = `${slug}-${ev.id.slice(0, 4)}`
    }
    slugCounts[slug] = (slugCounts[slug] || 0) + 1
    newManifest[slug] = pick(ev, MANIFEST_FIELDS)
  }

  // Diff
  const oldSlugs = new Set(Object.keys(oldManifest))
  const newSlugs = new Set(Object.keys(newManifest))

  const added = [...newSlugs].filter(s => !oldSlugs.has(s))
  const removed = [...oldSlugs].filter(s => !newSlugs.has(s))
  const kept = [...newSlugs].filter(s => oldSlugs.has(s))

  // Check for changed data in kept events
  const changed = kept.filter(s => JSON.stringify(newManifest[s]) !== JSON.stringify(oldManifest[s]))

  console.log(`\nDiff: +${added.length} new, ~${changed.length} changed, -${removed.length} removed, =${kept.length - changed.length} unchanged`)

  if (dryRun) {
    if (added.length) console.log('\nNew:', added.slice(0, 10).join(', '), added.length > 10 ? `... +${added.length - 10} more` : '')
    if (removed.length) console.log('Removed:', removed.slice(0, 10).join(', '), removed.length > 10 ? `... +${removed.length - 10} more` : '')
    if (changed.length) console.log('Changed:', changed.slice(0, 10).join(', '), changed.length > 10 ? `... +${changed.length - 10} more` : '')
    console.log('\nUse --apply to write files.')
    process.exit(0)
  }

  // Ensure base directory
  if (!existsSync(KALENDARZ_DIR)) mkdirSync(KALENDARZ_DIR, { recursive: true })

  // Generate OG images for new + changed events
  const toGenerate = [...added, ...changed]
  let generated = 0

  for (const slug of toGenerate) {
    const dir = resolve(KALENDARZ_DIR, slug)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const ogPath = resolve(dir, 'og.png')
    try {
      const size = await generateEventOg(newManifest[slug], ogPath)
      generated++
      if (generated % 50 === 0) console.log(`  Generated ${generated}/${toGenerate.length} OG images...`)
    } catch (err) {
      console.error(`  ERR generating OG for ${slug}: ${err.message}`)
    }
  }
  console.log(`Generated ${generated} OG images`)

  // Remove OG images for removed events
  for (const slug of removed) {
    const dir = resolve(KALENDARZ_DIR, slug)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true })
    }
  }
  if (removed.length) console.log(`Removed ${removed.length} old event directories`)

  // Write manifest
  writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2))
  console.log(`Manifest written: ${Object.keys(newManifest).length} events`)
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 3: Add `.gitignore` entry for kalendarz directory (keep manifest + og.png, ignore nothing extra)**

No gitignore changes needed — the manifest and OG images should all be committed. Just make sure the `public/kalendarz/` directory gets committed.

- [ ] **Step 4: Test locally**

```bash
cd backend && node --env-file=../.env scripts/publish-event-pages.js
# Should show dry run summary

cd backend && node --env-file=../.env scripts/publish-event-pages.js --apply
# Should create public/public/kalendarz/.manifest.json and og.png files
```

Verify:
- `public/public/kalendarz/.manifest.json` exists and has event data
- A few `public/public/kalendarz/{slug}/og.png` files exist and are valid 1200x630 PNGs

- [ ] **Step 5: Commit**

```bash
git add public/scripts/generate-event-og.js backend/scripts/publish-event-pages.js
git commit -m "feat: add publish script for event manifest and OG images"
```

---

### Task 5: Post-build script — HTML + sitemap generation

**Files:**
- Create: `public/scripts/generate-event-pages.js`
- Modify: `public/package.json:8` (update build script)
- Delete: `public/public/sitemap.xml` (replaced by build-time generation)

- [ ] **Step 1: Create the post-build script**

This runs after `vite build` on Vercel. Reads manifest, generates HTML files + sitemap into `dist/`.

```js
// public/scripts/generate-event-pages.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/kalendarz/.manifest.json')

const BASE_URL = 'https://leszy.run'

const TYPE_LABELS = {
  trail: 'trail', nocny: 'nocny', ocr: 'OCR', nordic: 'nordic walking',
  ultra: 'ultramaraton', charytatywny: 'charytatywny', uliczny: 'uliczny',
}

const POLISH_MONTHS = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
]

function formatDatePolish(dateStr) {
  const d = new Date(dateStr)
  return `${d.getDate()} ${POLISH_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildDescription(event) {
  const parts = [formatDatePolish(event.date)]
  if (event.location) parts.push(event.location)
  if (event.distances?.length) parts.push(event.distances.join(' / '))
  const types = (event.event_type || []).filter(t => t !== 'bieg').map(t => TYPE_LABELS[t] || t)
  if (types.length) parts.push(types.join(', '))
  return parts.join(' · ')
}

function buildJsonLd(event, slug) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: event.name,
    startDate: event.date,
    url: `${BASE_URL}/kalendarz/${slug}`,
    location: {
      '@type': 'Place',
      name: event.location || event.voivodeship || 'Polska',
      address: {
        '@type': 'PostalAddress',
        addressRegion: event.voivodeship || undefined,
        addressCountry: 'PL',
      },
    },
  }
  if (event.end_date) ld.endDate = event.end_date
  if (event.lat && event.lng) {
    ld.location.geo = { '@type': 'GeoCoordinates', latitude: Number(event.lat), longitude: Number(event.lng) }
  }
  if (event.price_from) {
    ld.offers = {
      '@type': 'AggregateOffer', lowPrice: Number(event.price_from),
      priceCurrency: 'PLN', availability: 'https://schema.org/InStock',
    }
    if (event.price_to) ld.offers.highPrice = Number(event.price_to)
    if (event.registration_url) ld.offers.url = event.registration_url
  }
  return ld
}

function generateHtml(event, slug, templateParts) {
  const title = `${escapeHtml(event.name)} — ${formatDatePolish(event.date)} — Leszy.run`
  const description = escapeHtml(buildDescription(event))
  const canonical = `${BASE_URL}/kalendarz/${slug}`
  const ogImage = `${BASE_URL}/kalendarz/${slug}/og.png`
  const jsonLd = JSON.stringify(buildJsonLd(event, slug))
  const eventJson = JSON.stringify(event)

  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />

    <meta property="og:type" content="website" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${ogImage}" />

    <link rel="icon" type="image/svg+xml" href="/logo-bez-napisu.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">

    <script type="application/ld+json">${jsonLd}</script>

    <script>
      (function() {
        var t = localStorage.getItem('leszy-theme');
        if (t === 'dark') document.documentElement.classList.add('dark');
        else if (t === 'light' || !window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('light');
      })();
    </script>

    ${templateParts.cssLinks}
  </head>
  <body>
    <div id="root"></div>
    <script id="event-data" type="application/json">${eventJson.replace(/<\//g, '<\\/')}</script>
    ${templateParts.scripts}
  </body>
</html>`
}

function generateSitemap(slugs) {
  const staticUrls = [
    { loc: '/', changefreq: 'weekly', priority: '1.0' },
    { loc: '/kalendarz', changefreq: 'daily', priority: '0.9' },
    { loc: '/kalendarz/dodaj', changefreq: 'monthly', priority: '0.5' },
    { loc: '/events', changefreq: 'weekly', priority: '0.7' },
  ]

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'

  for (const u of staticUrls) {
    xml += `  <url>\n    <loc>${BASE_URL}${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>\n`
  }

  for (const slug of slugs) {
    xml += `  <url>\n    <loc>${BASE_URL}/kalendarz/${slug}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`
  }

  xml += '</urlset>\n'
  return xml
}

function extractTemplateParts(indexHtml) {
  // Extract CSS links (Vite injects <link rel="stylesheet"> in head)
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')

  // Extract script tags from body (Vite injects <script type="module" src="/assets/...">)
  const scripts = (indexHtml.match(/<script[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')

  return { cssLinks, scripts }
}

function main() {
  // Check manifest exists
  if (!existsSync(MANIFEST_PATH)) {
    console.log('No manifest found at', MANIFEST_PATH, '— skipping event page generation')
    return
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  const slugs = Object.keys(manifest)
  console.log(`Generating ${slugs.length} event pages...`)

  // Read built index.html to extract Vite's hashed assets
  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) {
    console.error('dist/index.html not found — run vite build first')
    process.exit(1)
  }
  const indexHtml = readFileSync(indexPath, 'utf-8')
  const templateParts = extractTemplateParts(indexHtml)

  // Generate HTML per event
  let count = 0
  for (const [slug, event] of Object.entries(manifest)) {
    const dir = resolve(DIST, 'kalendarz', slug)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const html = generateHtml(event, slug, templateParts)
    writeFileSync(resolve(dir, 'index.html'), html)
    count++
  }
  console.log(`Generated ${count} event HTML files`)

  // Generate sitemap
  const sitemap = generateSitemap(slugs)
  writeFileSync(resolve(DIST, 'sitemap.xml'), sitemap)
  console.log(`Sitemap written with ${slugs.length + 4} URLs`)
}

main()
```

- [ ] **Step 2: Update build script in package.json**

In `public/package.json`, change the `build` script:

```json
"build": "node scripts/generate-og-image.js && vite build && node scripts/generate-event-pages.js",
```

- [ ] **Step 3: Delete the static sitemap**

Remove `public/public/sitemap.xml` — it's now generated at build time into `dist/sitemap.xml`.

```bash
rm public/public/sitemap.xml
```

- [ ] **Step 4: Test the build locally**

```bash
cd public && npm run build
```

Verify:
- `dist/kalendarz/` directories exist with `index.html` files
- Open one: has correct `<title>`, OG tags, `<script id="event-data">`, Vite script tag
- `dist/sitemap.xml` has static entries + event URLs
- The static sitemap at `public/public/sitemap.xml` is gone

- [ ] **Step 5: Commit**

```bash
git add public/scripts/generate-event-pages.js public/package.json
git rm public/public/sitemap.xml
git commit -m "feat: post-build script generates event HTML pages and sitemap"
```

---

### Task 6: End-to-end test and cleanup

**Files:**
- No new files

- [ ] **Step 1: Run full publish + build flow**

```bash
# 1. Generate manifest + OG images
cd backend && node --env-file=../.env scripts/publish-event-pages.js --apply

# 2. Build
cd ../public && npm run build

# 3. Preview
npx vite preview
```

- [ ] **Step 2: Test direct URL hit (static HTML)**

Open `http://localhost:4173/kalendarz/{any-slug-from-manifest}` in browser.

Verify:
- Page renders with event data (no loading spinner — data is embedded)
- View source: `<title>`, OG tags, JSON-LD, `<script id="event-data">` all present
- Map loads
- "Zgłoś poprawkę" button works
- "W okolicy tego weekendu" loads nearby events
- CTA buttons link to correct external URLs

- [ ] **Step 3: Test SPA navigation (no static HTML)**

Open `http://localhost:4173/kalendarz`, click on any event.

Verify:
- Navigates to `/kalendarz/{slug}` via React Router (no full page reload)
- Event page loads (brief loading state while Supabase query runs)
- All same features work as step 2
- Back button returns to calendar list

- [ ] **Step 4: Test social sharing preview**

Use an OG debugger (e.g. https://developers.facebook.com/tools/debug/ or opengraph.xyz) with one of the built event URLs. Or just `curl -s` a built HTML file and check the meta tags are in the raw HTML.

```bash
head -30 dist/kalendarz/$(ls dist/kalendarz/ | head -1)/index.html
```

Should show proper `<title>`, `og:title`, `og:image`, `og:description` in the raw HTML.

- [ ] **Step 5: Test 404 handling**

Open `http://localhost:4173/kalendarz/nonexistent-event-2099-01-01`.

Verify: shows "Nie znaleziono wydarzenia" with link back to calendar.

- [ ] **Step 6: Commit manifest and OG images**

```bash
git add public/public/kalendarz/
git commit -m "feat: add event manifest and OG images"
```

