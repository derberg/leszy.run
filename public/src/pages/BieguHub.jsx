import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useSeo from '../hooks/useSeo.js'
import { TYPE_H1_NOUN, REGION_SLUG_TO_DB, SPECIAL_H1, SPECIAL_SLUGS } from '../lib/biegi-mappings.js'

const TYPE_SLUGS = Object.keys(TYPE_H1_NOUN)

function LinkCard({ path, h1, eventCount }) {
  return (
    <Link
      to={`/${path}`}
      className="block border border-apex-border bg-apex-surface hover:border-apex-yellow/40 hover:bg-apex-yellow/[0.04] transition-all p-4 group"
    >
      <div className="font-display font-bold text-base tracking-wide uppercase text-apex-text-bright group-hover:text-apex-yellow transition-colors">
        {h1}
      </div>
      {eventCount > 0 && (
        <div className="font-mono text-[11px] text-apex-muted mt-1">{eventCount} wydarzeń</div>
      )}
    </Link>
  )
}

export default function BieguHub() {
  const [entries, setEntries] = useState({})

  useSeo({
    title: `Biegi w Polsce — kalendarz biegów`,
    description: 'Kalendarz biegów w Polsce. Biegi przełajowe, uliczne, ultramaratony, nordic walking i więcej. Sprawdź pełny kalendarz według typu i województwa.',
    path: '/listy',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: 'Biegi w Polsce — kalendarz biegów',
          description: 'Kalendarz biegów w Polsce. Biegi przełajowe, uliczne, ultramaratony, nordic walking i więcej.',
          url: 'https://www.leszy.run/listy',
          inLanguage: 'pl-PL',
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: 'https://www.leszy.run' },
            { '@type': 'ListItem', position: 2, name: 'Lista kategorii', item: 'https://www.leszy.run/listy' },
          ],
        },
      ],
    },
  })

  useEffect(() => {
    // Read from static landing-data if present (server-side render)
    const scriptEl = document.getElementById('landing-data')
    if (scriptEl) {
      try {
        const data = JSON.parse(scriptEl.textContent)
        // data is the hub manifest entry; relatedLinks has all type/region/special entries
        const byPath = {}
        for (const link of (data.relatedLinks || [])) {
          byPath[link.path] = link
        }
        setEntries(byPath)
        return
      } catch {}
    }
    // Fallback: fetch manifest
    fetch('/listy/.manifest.json')
      .then(r => r.json())
      .then(manifest => {
        const byPath = {}
        for (const [path, entry] of Object.entries(manifest)) {
          byPath[path] = { path, h1: entry.h1, eventCount: entry.eventCount }
        }
        setEntries(byPath)
      })
      .catch(() => {})
  }, [])

  const typeEntries = TYPE_SLUGS.map(s => entries[`listy/${s}`]).filter(Boolean)
  const regionEntries = Object.keys(REGION_SLUG_TO_DB).map(s => entries[`listy/${s}`]).filter(Boolean)
  const specialEntries = SPECIAL_SLUGS.map(s => entries[`listy/${s}`]).filter(Boolean)
  const knownSingleSlugs = new Set([
    ...TYPE_SLUGS.map(t => `listy/${t}`),
    ...Object.keys(REGION_SLUG_TO_DB).map(r => `listy/${r}`),
    ...SPECIAL_SLUGS.map(s => `listy/${s}`),
    'listy',
  ])
  const cityEntries = Object.values(entries)
    .filter(e => e.path && !knownSingleSlugs.has(e.path) && !e.path.slice('listy/'.length).includes('/'))
    .sort((a, b) => a.h1.localeCompare(b.h1, 'pl'))

  return (
    <>
      <Navbar />
      <main id="main-content" className="pt-20 pb-16 px-6 max-w-[1200px] mx-auto">
        <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">Biegi w Polsce</p>
        <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">Kalendarz biegów</h1>
        <p className="text-base text-apex-text max-w-[600px] mb-10">
          Przeglądaj biegi według typu, województwa lub daty. Wszystkie zawody w jednym miejscu.
        </p>

        {typeEntries.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-lg tracking-widest uppercase text-apex-yellow-dim mb-4 border-b border-apex-border pb-2">Według typu</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {typeEntries.map(e => <LinkCard key={e.path} {...e} />)}
            </div>
          </section>
        )}

        {regionEntries.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-lg tracking-widest uppercase text-apex-yellow-dim mb-4 border-b border-apex-border pb-2">Według województwa</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {regionEntries.map(e => <LinkCard key={e.path} {...e} />)}
            </div>
          </section>
        )}

        {specialEntries.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-lg tracking-widest uppercase text-apex-yellow-dim mb-4 border-b border-apex-border pb-2">Specjalne</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {specialEntries.map(e => <LinkCard key={e.path} {...e} />)}
            </div>
          </section>
        )}

        {cityEntries.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-lg tracking-widest uppercase text-apex-yellow-dim mb-4 border-b border-apex-border pb-2">Według miasta</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {cityEntries.map(e => <LinkCard key={e.path} {...e} />)}
            </div>
          </section>
        )}

        <div className="pt-4">
          <Link
            to="/kalendarz"
            className="font-display font-bold text-[12px] tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all inline-block"
          >
            Przeglądaj pełny kalendarz →
          </Link>
        </div>
      </main>
      <Footer />
    </>
  )
}
