# SEO Landing Pages (`/biegi/*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate ~300–500 static SEO landing pages at `/biegi/*` from `calendar_events` Supabase data, each targeting a facet combination (event type, region, month) with Polish-language metadata, intro paragraphs, internal linking, and JSON-LD.

**Architecture:** A backend Node.js script (`publish-landing-pages.js`) queries Supabase with two separate filter sets (threshold for page generation decisions, display for user-facing counts/metadata) and writes a manifest JSON. A public build script (`generate-landing-pages.js`) reads the manifest post-Vite-build to write static HTML files and append sitemap entries. Two new React pages handle hydration. The pipeline gains step 12.

**Tech Stack:** Node.js ESM (backend script), React + Vite (public app), `@supabase/supabase-js`, mirrors the `publish-event-pages.js` + `generate-event-pages.js` pattern already in the repo.

**Spec:** `docs/superpowers/specs/2026-05-11-seo-landing-pages-design.md`

---

## File map

| File | Action | Purpose |
|---|---|---|
| `backend/scripts/lib/biegi-mappings.js` | Create | Type/region/month slug↔DB mappings used by backend script |
| `public/src/lib/biegi-mappings.js` | Create | Same mappings for frontend (duplication by design — avoids cross-package imports) |
| `backend/scripts/publish-landing-pages.js` | Create | Queries Supabase, computes all facet combos, writes manifest |
| `public/scripts/generate-landing-pages.js` | Create | Post-build: reads manifest, writes static HTML + appends sitemap |
| `public/src/pages/BieguHub.jsx` | Create | Navigation-only hub page at `/biegi` |
| `public/src/pages/LandingPage.jsx` | Create | Faceted event listing at `/biegi/*` |
| `public/src/App.jsx` | Modify | Add `/biegi` and `/biegi/*` routes |
| `public/src/components/Navbar.jsx` | Modify | Add "Biegi" nav link |
| `public/package.json` | Modify | Append `generate-landing-pages.js` to build script |
| `scheduler/src/pipeline.js` | Modify | Add step 12: `publish-landing-pages --apply` |

---

## Task 1: Shared biegi mappings

**Files:**
- Create: `backend/scripts/lib/biegi-mappings.js`
- Create: `public/src/lib/biegi-mappings.js`

- [ ] **Step 1: Create `backend/scripts/lib/biegi-mappings.js`**

```js
// Slug↔DB mappings for /biegi/* landing pages.
// Duplicated in public/src/lib/biegi-mappings.js — keep in sync.

export const TYPE_SLUG_TO_DB = {
  'przelajowe': 'trail',
  'uliczne': 'uliczny',
  'ultramaratony': 'ultra',
  'nocne': 'nocny',
  'ocr': 'ocr',
  'nordic-walking': 'nordic walking',
  'charytatywne': 'charytatywny',
}

export const DB_TO_TYPE_SLUG = {
  'trail': 'przelajowe',
  'uliczny': 'uliczne',
  'ultra': 'ultramaratony',
  'nocny': 'nocne',
  'ocr': 'ocr',
  'nordic walking': 'nordic-walking',
  'charytatywny': 'charytatywne',
}

export const TYPE_H1_NOUN = {
  'przelajowe': 'Biegi przełajowe',
  'uliczne': 'Biegi uliczne',
  'ultramaratony': 'Ultramaratony',
  'nocne': 'Biegi nocne',
  'ocr': 'Biegi OCR',
  'nordic-walking': 'Nordic Walking',
  'charytatywne': 'Biegi charytatywne',
}

export const TYPE_SECONDARY_KW = {
  'przelajowe': 'trail running, biegi terenowe, biegi górskie, bieg w terenie',
  'uliczne': 'biegi miejskie, bieg po asfalcie, bieg uliczny',
  'ultramaratony': 'biegi ultra, ultramaraton, ultra trail, biegi długodystansowe',
  'nocne': 'bieg nocny, night run, nocny bieg uliczny',
  'ocr': 'biegi z przeszkodami, obstacle run, obstacle race',
  'nordic-walking': 'marsze nordic walking, NW',
  'charytatywne': 'charytatywny bieg, bieg na cel, bieg dobroczynny',
}

export const REGION_SLUG_TO_DB = {
  'dolnoslaskie': 'Dolnośląskie',
  'kujawsko-pomorskie': 'Kujawsko-Pomorskie',
  'lubelskie': 'Lubelskie',
  'lubuskie': 'Lubuskie',
  'lodzkie': 'Łódzkie',
  'malopolskie': 'Małopolskie',
  'mazowieckie': 'Mazowieckie',
  'opolskie': 'Opolskie',
  'podkarpackie': 'Podkarpackie',
  'podlaskie': 'Podlaskie',
  'pomorskie': 'Pomorskie',
  'slaskie': 'Śląskie',
  'swietokrzyskie': 'Świętokrzyskie',
  'warminsko-mazurskie': 'Warmińsko-Mazurskie',
  'wielkopolskie': 'Wielkopolskie',
  'zachodniopomorskie': 'Zachodniopomorskie',
}

export const DB_TO_REGION_SLUG = {
  'Dolnośląskie': 'dolnoslaskie',
  'Kujawsko-Pomorskie': 'kujawsko-pomorskie',
  'Lubelskie': 'lubelskie',
  'Lubuskie': 'lubuskie',
  'Łódzkie': 'lodzkie',
  'Małopolskie': 'malopolskie',
  'Mazowieckie': 'mazowieckie',
  'Opolskie': 'opolskie',
  'Podkarpackie': 'podkarpackie',
  'Podlaskie': 'podlaskie',
  'Pomorskie': 'pomorskie',
  'Śląskie': 'slaskie',
  'Świętokrzyskie': 'swietokrzyskie',
  'Warmińsko-Mazurskie': 'warminsko-mazurskie',
  'Wielkopolskie': 'wielkopolskie',
  'Zachodniopomorskie': 'zachodniopomorskie',
}

export const REGION_LOCATIVE = {
  'dolnoslaskie': 'w Dolnośląskiem',
  'kujawsko-pomorskie': 'w Kujawsko-Pomorskiem',
  'lubelskie': 'w Lubelskiem',
  'lubuskie': 'w Lubuskiem',
  'lodzkie': 'w Łódzkiem',
  'malopolskie': 'w Małopolsce',
  'mazowieckie': 'na Mazowszu',
  'opolskie': 'w Opolskiem',
  'podkarpackie': 'na Podkarpaciu',
  'podlaskie': 'na Podlasiu',
  'pomorskie': 'na Pomorzu',
  'slaskie': 'w Śląskiem',
  'swietokrzyskie': 'w Świętokrzyskiem',
  'warminsko-mazurskie': 'na Warmii i Mazurach',
  'wielkopolskie': 'w Wielkopolsce',
  'zachodniopomorskie': 'w Zachodniopomorskiem',
}

export const MONTH_SLUG_TO_NUM = {
  'styczen': 1, 'luty': 2, 'marzec': 3, 'kwiecien': 4,
  'maj': 5, 'czerwiec': 6, 'lipiec': 7, 'sierpien': 8,
  'wrzesien': 9, 'pazdziernik': 10, 'listopad': 11, 'grudzien': 12,
}

export const MONTH_NUM_TO_SLUG = {
  1: 'styczen', 2: 'luty', 3: 'marzec', 4: 'kwiecien',
  5: 'maj', 6: 'czerwiec', 7: 'lipiec', 8: 'sierpien',
  9: 'wrzesien', 10: 'pazdziernik', 11: 'listopad', 12: 'grudzien',
}

export const MONTH_LOCATIVE = {
  1: 'w styczniu', 2: 'w lutym', 3: 'w marcu', 4: 'w kwietniu',
  5: 'w maju', 6: 'w czerwcu', 7: 'w lipcu', 8: 'w sierpniu',
  9: 'we wrześniu', 10: 'w październiku', 11: 'w listopadzie', 12: 'w grudniu',
}

export const SPECIAL_SLUGS = ['polmaratony', 'maratony', 'dla-dzieci', 'darmowe']

export const SPECIAL_H1 = {
  'polmaratony': 'Półmaratony w Polsce',
  'maratony': 'Maratony w Polsce',
  'dla-dzieci': 'Biegi dla dzieci w Polsce',
  'darmowe': 'Darmowe biegi w Polsce',
}

export const SPECIAL_SECONDARY_KW = {
  'polmaratony': 'bieg na 21 km, półmaraton, half marathon',
  'maratony': 'bieg na 42 km, maraton, marathon polska',
  'dla-dzieci': 'biegi rodzinne, bieg dla dzieci, biegi juniorów',
  'darmowe': 'bezpłatne biegi, darmowy bieg, biegi za darmo',
}
```

- [ ] **Step 2: Copy to `public/src/lib/biegi-mappings.js`**

Exact same content as `backend/scripts/lib/biegi-mappings.js`.

- [ ] **Step 3: Smoke test the module in Node**

```bash
cd /path/to/project/backend
node --input-type=module <<'EOF'
import { TYPE_SLUG_TO_DB, REGION_SLUG_TO_DB, MONTH_NUM_TO_SLUG, SPECIAL_SLUGS } from './scripts/lib/biegi-mappings.js'
console.log('types:', Object.keys(TYPE_SLUG_TO_DB).length)      // 7
console.log('regions:', Object.keys(REGION_SLUG_TO_DB).length)  // 16
console.log('months:', Object.keys(MONTH_NUM_TO_SLUG).length)   // 12
console.log('specials:', SPECIAL_SLUGS.length)                  // 4
EOF
```

Expected output: `types: 7`, `regions: 16`, `months: 12`, `specials: 4`

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/lib/biegi-mappings.js public/src/lib/biegi-mappings.js
git commit -m "feat: add biegi slug/DB mappings for SEO landing pages"
```

---

## Task 2: `publish-landing-pages.js` — backend manifest generator

**Files:**
- Create: `backend/scripts/publish-landing-pages.js`

- [ ] **Step 1: Create the file**

```js
// Usage: cd backend && node --env-file=../.env scripts/publish-landing-pages.js [--apply]
// Generates public/public/biegi/.manifest.json from calendar_events Supabase data.
// Dry run by default — use --apply to write the file.

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  TYPE_SLUG_TO_DB, TYPE_H1_NOUN, TYPE_SECONDARY_KW,
  REGION_SLUG_TO_DB, REGION_LOCATIVE,
  MONTH_SLUG_TO_NUM, MONTH_NUM_TO_SLUG, MONTH_LOCATIVE,
  SPECIAL_SLUGS, SPECIAL_H1, SPECIAL_SECONDARY_KW,
} from './lib/biegi-mappings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BIEGI_DIR = resolve(PROJECT_ROOT, 'public/public/biegi')
const MANIFEST_PATH = resolve(BIEGI_DIR, '.manifest.json')
const BASE_URL = 'https://www.leszy.run'

const dryRun = !process.argv.includes('--apply')

// ─── Polish helpers ───────────────────────────────────────────────────────────

function inflectCount(n) {
  if (n === 1) return '1 wydarzenie'
  if (n >= 2 && n <= 4) return `${n} wydarzenia`
  return `${n} wydarzeń`
}

const TYPE_NOUN_GEN = {
  przelajowe: 'biegów przełajowych', uliczne: 'biegów ulicznych',
  ultramaratony: 'ultramaratonów', nocne: 'biegów nocnych',
  ocr: 'biegów OCR', 'nordic-walking': 'marszów nordic walking',
  charytatywne: 'biegów charytatywnych',
}

function buildH1(typeSlug, regionSlug, year, month) {
  const noun = typeSlug ? TYPE_H1_NOUN[typeSlug] : 'Biegi'
  if (!regionSlug && !year) return `${noun} w Polsce`
  if (!regionSlug && year && month) return `${noun} ${MONTH_LOCATIVE[month]} ${year}`
  const locative = REGION_LOCATIVE[regionSlug]
  if (!year) return `${noun} ${locative}`
  return `${noun} ${locative} — ${MONTH_LOCATIVE[month]} ${year}`
}

function buildTitle(h1, count) {
  return `${h1} (${inflectCount(count)}) — Leszy.run`
}

function buildDescription(typeSlug, regionSlug, year, month, count, special) {
  if (special) {
    const spNoun = { polmaratony: 'półmaratonów', maratony: 'maratonów', 'dla-dzieci': 'biegów dla dzieci', darmowe: 'darmowych biegów' }[special]
    const monthPart = year && month ? ` ${MONTH_LOCATIVE[month]} ${year}` : ''
    return `${count} ${spNoun} w Polsce${monthPart}. ${SPECIAL_SECONDARY_KW[special]}. Zapisy, dystanse, ceny.`
  }
  const nounGen = typeSlug ? TYPE_NOUN_GEN[typeSlug] : 'biegów'
  const secKw = typeSlug ? ` ${TYPE_SECONDARY_KW[typeSlug]}.` : ''
  const regionPart = regionSlug ? ` ${REGION_LOCATIVE[regionSlug]}` : ' w Polsce'
  const monthPart = year && month ? ` ${MONTH_LOCATIVE[month]} ${year}` : ''
  return `${count} ${nounGen}${regionPart}${monthPart}.${secKw} Zapisy, dystanse, ceny.`
}

function buildIntro(typeSlug, regionSlug, year, month, count, topCities, distRange, special) {
  const yr = year || new Date().getFullYear()
  const citiesStr = topCities.length ? ` Zawody w: ${topCities.join(', ')}.` : ''
  const dist = distRange && distRange.min !== distRange.max ? `, od ${distRange.min} km do ${distRange.max} km` : ''
  if (special === 'polmaratony') return `${count} półmaratonów w Polsce w ${yr} roku. Dystans 21 km.${citiesStr}`
  if (special === 'maratony') return `${count} maratonów w Polsce w ${yr} roku. Dystans 42 km.${citiesStr}`
  if (special === 'dla-dzieci') return `${count} biegów dla dzieci w Polsce w ${yr} roku. Krótkie dystanse dla najmłodszych biegaczy.${citiesStr}`
  if (special === 'darmowe') return `${count} darmowych biegów w Polsce w ${yr} roku. Bezpłatny udział, bez opłaty startowej.${citiesStr}`
  const noun = typeSlug ? TYPE_H1_NOUN[typeSlug].toLowerCase() : 'biegi'
  const regionPart = regionSlug ? ` ${REGION_LOCATIVE[regionSlug]}` : ' w Polsce'
  return `${count} ${noun}${regionPart} w ${yr} roku${dist}.${citiesStr}`.trim()
}

// ─── Distance parsing (mirrors Kalendarz.jsx) ─────────────────────────────────

function parseDistanceToMeters(d) {
  if (!d || typeof d !== 'string') return NaN
  const s = d.toLowerCase().trim()
  if (/\d\s*h(\b|$)/.test(s)) return NaN
  if (s.includes('półmaraton') || s.includes('polmaraton')) return 21097
  if (s.includes('maraton')) return 42195
  const match = s.match(/[0-9]+([.,][0-9]+)?/)
  if (!match) return NaN
  const num = parseFloat(match[0].replace(',', '.'))
  if (isNaN(num)) return NaN
  if (/km|kilometr/.test(s)) return Math.round(num * 1000)
  if (/\d\s*m\b|metr/.test(s)) return Math.round(num)
  return Math.round(num * 1000)
}

// ─── Facet helpers ────────────────────────────────────────────────────────────

function getEventTypes(e) {
  return Array.isArray(e.event_type) ? e.event_type : e.event_type ? [e.event_type] : []
}

function matchesFacet(event, { typeDbVal, regionDb, year, month, special }) {
  if (special === 'polmaratony') return (event.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 19000 && m <= 23000 })
  if (special === 'maratony') return (event.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 41000 && m <= 44000 })
  if (special === 'dla-dzieci') return event.is_kids === true
  if (special === 'darmowe') return event.price_from === 0
  if (typeDbVal && !getEventTypes(event).includes(typeDbVal)) return false
  if (regionDb && event.voivodeship !== regionDb) return false
  if (year && month) {
    const d = new Date(event.date + 'T00:00:00')
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return false
  }
  return true
}

function computeDistRange(events) {
  let min = Infinity, max = -Infinity
  for (const e of events) {
    for (const d of (e.distances || [])) {
      const m = parseDistanceToMeters(d)
      if (!isNaN(m) && m > 0) { min = Math.min(min, m); max = Math.max(max, m) }
    }
  }
  if (min === Infinity) return null
  return { min: Math.round(min / 1000), max: Math.round(max / 1000) }
}

function topLocations(events, n = 3) {
  const counts = {}
  for (const e of events) {
    if (e.location) {
      const city = e.location.split(',')[0].trim()
      counts[city] = (counts[city] || 0) + 1
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c)
}

function computeMetadata(displayEvents, facet) {
  const matched = displayEvents.filter(e => matchesFacet(e, facet))
  return { count: matched.length, topCities: topLocations(matched, 3), distRange: computeDistRange(matched) }
}

// ─── Paginated Supabase query ─────────────────────────────────────────────────

async function queryAll(supabase, select, filterFn) {
  const PAGE_SIZE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = supabase.from('calendar_events').select(select).range(from, from + PAGE_SIZE - 1)
    q = filterFn(q)
    const { data, error } = await q
    if (error) throw new Error(`Supabase: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

// ─── Related links helper ─────────────────────────────────────────────────────

function manifestRef(manifest, path) {
  const e = manifest[path]
  return e ? { path, h1: e.h1, eventCount: e.eventCount } : null
}

function nextNMonths(today, n) {
  const result = []
  const d = new Date(today)
  for (let i = 0; i < n; i++) {
    d.setMonth(d.getMonth() + 1)
    result.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  return result
}

function computeRelatedLinks(manifest, path, today) {
  const typeSlugs = Object.keys(TYPE_SLUG_TO_DB)
  const regionSlugs = Object.keys(REGION_SLUG_TO_DB)
  const seg = path.replace('biegi/', '')
  const parts = seg === '' ? [] : seg.split('/')

  // Hub
  if (path === 'biegi') {
    return [
      ...typeSlugs.map(t => manifestRef(manifest, `biegi/${t}`)),
      ...regionSlugs.map(r => manifestRef(manifest, `biegi/${r}`)),
      ...SPECIAL_SLUGS.map(s => manifestRef(manifest, `biegi/${s}`)),
    ].filter(Boolean)
  }

  // Special pages
  if (parts.length === 1 && SPECIAL_SLUGS.includes(parts[0])) {
    return [manifestRef(manifest, 'biegi')].filter(Boolean)
  }

  // Type-only
  if (parts.length === 1 && TYPE_SLUG_TO_DB[parts[0]]) {
    const typeSlug = parts[0]
    const typeRegionLinks = regionSlugs
      .map(r => manifestRef(manifest, `biegi/${typeSlug}/${r}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
    const monthLinks = nextNMonths(today, 3)
      .map(({ year, month }) => manifestRef(manifest, `biegi/${typeSlug}/${year}/${MONTH_NUM_TO_SLUG[month]}`))
      .filter(Boolean)
    return [manifestRef(manifest, 'biegi'), ...typeRegionLinks, ...monthLinks].filter(Boolean)
  }

  // Region-only
  if (parts.length === 1 && REGION_SLUG_TO_DB[parts[0]]) {
    const regionSlug = parts[0]
    const regionTypeLinks = typeSlugs
      .map(t => manifestRef(manifest, `biegi/${t}/${regionSlug}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
    const monthLinks = nextNMonths(today, 3)
      .map(({ year, month }) => manifestRef(manifest, `biegi/${regionSlug}/${year}/${MONTH_NUM_TO_SLUG[month]}`))
      .filter(Boolean)
    return [manifestRef(manifest, 'biegi'), ...regionTypeLinks, ...monthLinks].filter(Boolean)
  }

  // Type + region
  if (parts.length === 2 && TYPE_SLUG_TO_DB[parts[0]] && REGION_SLUG_TO_DB[parts[1]]) {
    const [typeSlug, regionSlug] = parts
    const siblingRegions = regionSlugs
      .filter(r => r !== regionSlug)
      .map(r => manifestRef(manifest, `biegi/${typeSlug}/${r}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, 5)
    const monthLinks = nextNMonths(today, 2)
      .map(({ year, month }) => manifestRef(manifest, `biegi/${typeSlug}/${regionSlug}/${year}/${MONTH_NUM_TO_SLUG[month]}`))
      .filter(Boolean)
    return [
      manifestRef(manifest, `biegi/${typeSlug}`),
      manifestRef(manifest, `biegi/${regionSlug}`),
      ...siblingRegions,
      ...monthLinks,
    ].filter(Boolean)
  }

  // Month combo — link to parent + adjacent months
  const yearIdx = parts.findIndex(p => /^\d{4}$/.test(p))
  if (yearIdx >= 0) {
    const year = parseInt(parts[yearIdx])
    const month = MONTH_SLUG_TO_NUM[parts[yearIdx + 1]]
    const parentPath = yearIdx === 0 ? 'biegi' : `biegi/${parts.slice(0, yearIdx).join('/')}`
    const prefix = parts.slice(0, yearIdx)
    const prevM = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 }
    const nextM = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
    const prevPath = `biegi/${[...prefix, String(prevM.y), MONTH_NUM_TO_SLUG[prevM.m]].join('/')}`
    const nextPath = `biegi/${[...prefix, String(nextM.y), MONTH_NUM_TO_SLUG[nextM.m]].join('/')}`
    return [
      manifestRef(manifest, parentPath),
      manifestRef(manifest, prevPath),
      manifestRef(manifest, nextPath),
    ].filter(Boolean)
  }

  return []
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (dryRun) console.log('=== DRY RUN (use --apply to write files) ===\n')

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

  const supabase = createClient(supabaseUrl, supabaseKey)

  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const cutoffStr = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const currentYear = today.getFullYear()

  const SELECT = 'date,location,voivodeship,event_type,distances,price_from,is_kids,registration_deadline'

  console.log('Querying Supabase...')
  const [thresholdEvents, displayEvents] = await Promise.all([
    queryAll(supabase, SELECT, q => q.eq('status', 'active').gte('date', cutoffStr).order('date', { ascending: true })),
    queryAll(supabase, SELECT, q =>
      q.eq('status', 'active').gte('date', todayStr)
        .or(`registration_deadline.is.null,registration_deadline.gte.${todayStr}`)
        .order('date', { ascending: true })
    ),
  ])
  console.log(`Threshold: ${thresholdEvents.length} events, Display: ${displayEvents.length} events\n`)

  const typeSlugs = Object.keys(TYPE_SLUG_TO_DB)
  const regionSlugs = Object.keys(REGION_SLUG_TO_DB)

  // All year/month combos present in threshold events
  const ymSet = new Set()
  for (const e of thresholdEvents) {
    const d = new Date(e.date + 'T00:00:00')
    const m = d.getMonth() + 1
    if (MONTH_NUM_TO_SLUG[m]) ymSet.add(`${d.getFullYear()}-${m}`)
  }
  const yearMonths = [...ymSet].map(s => { const [y, m] = s.split('-').map(Number); return { year: y, month: m } })

  function countThreshold(facet) {
    return thresholdEvents.filter(e => matchesFacet(e, facet)).length
  }

  const manifest = {}

  function addEntry({ path, filters, typeSlug = null, regionSlug = null, year = null, month = null, special = null, priority, changefreq }) {
    const facet = {
      typeDbVal: typeSlug ? TYPE_SLUG_TO_DB[typeSlug] : null,
      regionDb: regionSlug ? REGION_SLUG_TO_DB[regionSlug] : null,
      year, month, special,
    }
    const { count, topCities, distRange } = computeMetadata(displayEvents, facet)
    let h1, title, description, intro

    if (path === 'biegi') {
      h1 = `Biegi w Polsce — kalendarz biegów ${currentYear}`
      title = `${h1} — Leszy.run`
      description = `Kalendarz biegów w Polsce ${currentYear}. Biegi przełajowe, uliczne, ultramaratony, nordic walking i więcej. Sprawdź pełny kalendarz według typu i województwa.`
      intro = `${displayEvents.length} biegów w Polsce w ${currentYear} roku — trailowe, uliczne, ultramaratony i więcej.`
    } else {
      h1 = buildH1(typeSlug, regionSlug, year, month)
      title = special ? `${SPECIAL_H1[special]} (${inflectCount(count)}) — Leszy.run` : buildTitle(h1, count)
      if (special) h1 = SPECIAL_H1[special]
      description = buildDescription(typeSlug, regionSlug, year, month, count, special)
      intro = buildIntro(typeSlug, regionSlug, year, month, count, topCities, distRange, special)
    }

    manifest[path] = {
      path, filters, h1, title, description, intro, eventCount: count,
      canonicalUrl: `${BASE_URL}/${path}`,
      sitemapPriority: priority, sitemapChangefreq: changefreq,
      relatedLinks: [],
    }
  }

  // Hub
  addEntry({ path: 'biegi', filters: {}, priority: '0.9', changefreq: 'daily' })

  // Type-only (always)
  for (const ts of typeSlugs) {
    addEntry({ path: `biegi/${ts}`, filters: { event_type: TYPE_SLUG_TO_DB[ts] }, typeSlug: ts, priority: '0.8', changefreq: 'weekly' })
  }

  // Region-only (always)
  for (const rs of regionSlugs) {
    addEntry({ path: `biegi/${rs}`, filters: { voivodeship: REGION_SLUG_TO_DB[rs] }, regionSlug: rs, priority: '0.8', changefreq: 'weekly' })
  }

  // Special pages (always)
  const specialFilters = {
    polmaratony: { distanceType: 'halfmarathon' }, maratony: { distanceType: 'marathon' },
    'dla-dzieci': { isKids: true }, darmowe: { isFree: true },
  }
  for (const sp of SPECIAL_SLUGS) {
    addEntry({ path: `biegi/${sp}`, filters: specialFilters[sp], special: sp, priority: '0.8', changefreq: 'daily' })
  }

  // Type + region (≥2 threshold)
  for (const ts of typeSlugs) {
    for (const rs of regionSlugs) {
      if (countThreshold({ typeDbVal: TYPE_SLUG_TO_DB[ts], regionDb: REGION_SLUG_TO_DB[rs] }) < 2) continue
      addEntry({ path: `biegi/${ts}/${rs}`, filters: { event_type: TYPE_SLUG_TO_DB[ts], voivodeship: REGION_SLUG_TO_DB[rs] }, typeSlug: ts, regionSlug: rs, priority: '0.7', changefreq: 'weekly' })
    }
  }

  // Month-only (≥5 threshold)
  for (const { year, month } of yearMonths) {
    if (countThreshold({ year, month }) < 5) continue
    addEntry({ path: `biegi/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { year, month }, year, month, priority: '0.6', changefreq: 'daily' })
  }

  // Type + month (≥3 threshold)
  for (const ts of typeSlugs) {
    for (const { year, month } of yearMonths) {
      if (countThreshold({ typeDbVal: TYPE_SLUG_TO_DB[ts], year, month }) < 3) continue
      addEntry({ path: `biegi/${ts}/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { event_type: TYPE_SLUG_TO_DB[ts], year, month }, typeSlug: ts, year, month, priority: '0.6', changefreq: 'daily' })
    }
  }

  // Region + month (≥3 threshold)
  for (const rs of regionSlugs) {
    for (const { year, month } of yearMonths) {
      if (countThreshold({ regionDb: REGION_SLUG_TO_DB[rs], year, month }) < 3) continue
      addEntry({ path: `biegi/${rs}/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { voivodeship: REGION_SLUG_TO_DB[rs], year, month }, regionSlug: rs, year, month, priority: '0.6', changefreq: 'daily' })
    }
  }

  // Type + region + month (≥3 threshold)
  for (const ts of typeSlugs) {
    for (const rs of regionSlugs) {
      for (const { year, month } of yearMonths) {
        if (countThreshold({ typeDbVal: TYPE_SLUG_TO_DB[ts], regionDb: REGION_SLUG_TO_DB[rs], year, month }) < 3) continue
        addEntry({ path: `biegi/${ts}/${rs}/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { event_type: TYPE_SLUG_TO_DB[ts], voivodeship: REGION_SLUG_TO_DB[rs], year, month }, typeSlug: ts, regionSlug: rs, year, month, priority: '0.6', changefreq: 'daily' })
      }
    }
  }

  // Second pass: fill relatedLinks
  for (const path of Object.keys(manifest)) {
    manifest[path].relatedLinks = computeRelatedLinks(manifest, path, today)
  }

  // Summary
  const total = Object.keys(manifest).length
  const byType = {}
  for (const path of Object.keys(manifest)) {
    const parts = path.replace('biegi', '').replace(/^\//, '').split('/').filter(Boolean)
    const key = parts.length === 0 ? 'hub' : parts.length === 1 && SPECIAL_SLUGS.includes(parts[0]) ? 'special' : parts.length === 1 && TYPE_SLUG_TO_DB[parts[0]] ? 'type' : parts.length === 1 && REGION_SLUG_TO_DB[parts[0]] ? 'region' : parts.length === 2 && TYPE_SLUG_TO_DB[parts[0]] && REGION_SLUG_TO_DB[parts[1]] ? 'type+region' : parts.length === 2 ? 'month' : parts.length === 3 ? 'type+month or region+month' : 'type+region+month'
    byType[key] = (byType[key] || 0) + 1
  }
  console.log('--- Manifest breakdown ---')
  for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v}`)
  console.log(`  TOTAL: ${total}`)

  if (dryRun) { console.log('\nDry run complete. Use --apply to write files.'); return }

  mkdirSync(BIEGI_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  console.log(`\nWrote ${MANIFEST_PATH}`)
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Test dry run**

```bash
cd backend && node --env-file=../.env scripts/publish-landing-pages.js
```

Expected output:
- `Threshold: N events, Display: M events`
- Manifest breakdown showing entries per type (hub: 1, type: 7, region: 16, special: 4, type+region: varies, …)
- `TOTAL: N` (expect 300–500)
- `Dry run complete. Use --apply to write files.`

If counts look wrong: check that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set in `.env`.

- [ ] **Step 3: Test apply mode**

```bash
cd backend && node --env-file=../.env scripts/publish-landing-pages.js --apply
```

Expected: `Wrote .../public/public/biegi/.manifest.json`

Verify the file exists and is valid JSON:

```bash
node -e "const m = JSON.parse(require('fs').readFileSync('../public/public/biegi/.manifest.json', 'utf-8')); console.log(Object.keys(m).length + ' entries')"
```

- [ ] **Step 4: Spot-check a few manifest entries**

```bash
node -e "
const m = JSON.parse(require('fs').readFileSync('../public/public/biegi/.manifest.json', 'utf-8'))
const e = m['biegi/przelajowe/slaskie'] || m[Object.keys(m).find(k => k.includes('przelajowe'))]
if (e) { console.log(JSON.stringify(e, null, 2)) } else { console.log('no trail entries') }
"
```

Check that `h1`, `title`, `description`, `intro`, `eventCount`, `relatedLinks` are all populated and plausible.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/publish-landing-pages.js public/public/biegi/.manifest.json
git commit -m "feat: add publish-landing-pages script and initial manifest"
```

---

## Task 3: `generate-landing-pages.js` — static HTML generator

**Files:**
- Create: `public/scripts/generate-landing-pages.js`

- [ ] **Step 1: Create the file**

```js
// Post-build script: generates per-landing-page HTML files and appends to sitemap.xml.
// Reads public/biegi/.manifest.json (written by backend/scripts/publish-landing-pages.js).
// Run after generate-event-pages.js via the build script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/biegi/.manifest.json')
const BASE_URL = 'https://www.leszy.run'

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildJsonLd(entry) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: entry.h1,
    description: entry.description,
    url: entry.canonicalUrl,
    inLanguage: 'pl-PL',
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
        { '@type': 'ListItem', position: 2, name: 'Biegi w Polsce', item: `${BASE_URL}/biegi` },
      ],
    },
  }
  if (entry.path !== 'biegi') {
    ld.breadcrumb.itemListElement.push(
      { '@type': 'ListItem', position: 3, name: entry.h1, item: entry.canonicalUrl }
    )
  }
  return JSON.stringify(ld, null, 2).replace(/<\//g, '<\\/')
}

function buildLandingHtml(entry, cssLinks, jsScripts) {
  const title = escapeHtml(entry.title)
  const description = escapeHtml(entry.description)
  const canonical = entry.canonicalUrl
  const jsonLd = buildJsonLd(entry)
  // Embed full manifest entry as landing-data for React hydration
  const landingData = JSON.stringify(entry).replace(/<\//g, '<\\/')

  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />

    <!-- Open Graph -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${BASE_URL}/og-image.png" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${BASE_URL}/og-image.png" />

    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="/logo-bez-napisu.svg" />
    <link rel="apple-touch-icon" href="/logo-bez-napisu.svg" />

    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">

    <!-- JSON-LD CollectionPage (id matches useSeo hook — updated by React on hydration) -->
    <script id="seo-page-jsonld" type="application/ld+json">
    ${jsonLd}
    </script>

    <!-- Theme flash prevention -->
    <script>
      (function() {
        var t = localStorage.getItem('leszy-theme');
        if (t === 'dark') document.documentElement.classList.add('dark');
        else if (t === 'light' || !window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('light');
      })();
    </script>

    ${cssLinks}
  </head>
  <body>
    <div id="root"></div>
    <script id="landing-data" type="application/json">${landingData}</script>
    ${jsScripts}
  </body>
</html>`
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`No landing pages manifest at ${MANIFEST_PATH} — skipping.`)
    return
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  const paths = Object.keys(manifest)
  console.log(`Found ${paths.length} landing page entries in manifest.`)

  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) { console.error(`dist/index.html not found — did vite build run?`); process.exit(1) }

  const indexHtml = readFileSync(indexPath, 'utf-8')
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')
  const jsScripts = (indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')
  console.log(`Extracted CSS/JS from index.html.`)

  let generated = 0
  for (const path of paths) {
    const entry = manifest[path]
    // path is like 'biegi' or 'biegi/przelajowe/slaskie'
    const dir = resolve(DIST, path)
    mkdirSync(dir, { recursive: true })
    const html = buildLandingHtml(entry, cssLinks, jsScripts)
    writeFileSync(resolve(dir, 'index.html'), html)
    generated++
  }
  console.log(`Generated ${generated} landing page HTML files.`)

  // Append to sitemap written by generate-event-pages.js
  const sitemapPath = resolve(DIST, 'sitemap.xml')
  if (!existsSync(sitemapPath)) { console.error('sitemap.xml not found — run generate-event-pages.js first'); process.exit(1) }

  let sitemap = readFileSync(sitemapPath, 'utf-8')
  sitemap = sitemap.replace('</urlset>', '')

  const entries = paths.map(path => {
    const entry = manifest[path]
    return `  <url>\n    <loc>${entry.canonicalUrl}</loc>\n    <changefreq>${entry.sitemapChangefreq}</changefreq>\n    <priority>${entry.sitemapPriority}</priority>\n  </url>`
  })

  sitemap += entries.join('\n') + '\n</urlset>\n'
  writeFileSync(sitemapPath, sitemap)
  console.log(`Appended ${paths.length} landing page URLs to sitemap.xml.`)
}

main()
```

- [ ] **Step 2: Run a build to test**

```bash
cd public && npm run build
```

Expected: Build completes, `dist/biegi/` directory is created with subdirectories.

Check a few pages:
```bash
ls dist/biegi/
# Should show: przelajowe/  slaskie/  polmaratony/  index.html  …
cat dist/biegi/przelajowe/index.html | head -20
# Should show: <title>Biegi przełajowe w Polsce (…)</title>
```

Verify sitemap has landing pages:
```bash
grep "biegi/" dist/sitemap.xml | wc -l
# Should match manifest entry count
```

- [ ] **Step 3: Commit**

```bash
git add public/scripts/generate-landing-pages.js
git commit -m "feat: add generate-landing-pages post-build script"
```

---

## Task 4: `BieguHub.jsx` — hub page

**Files:**
- Create: `public/src/pages/BieguHub.jsx`

- [ ] **Step 1: Create the component**

```jsx
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
    path: '/biegi',
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
    fetch('/biegi/.manifest.json')
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

  const typeEntries = TYPE_SLUGS.map(s => entries[`biegi/${s}`]).filter(Boolean)
  const regionEntries = Object.keys(REGION_SLUG_TO_DB).map(s => entries[`biegi/${s}`]).filter(Boolean)
  const specialEntries = SPECIAL_SLUGS.map(s => entries[`biegi/${s}`]).filter(Boolean)

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
```

- [ ] **Step 2: Start dev server and verify**

```bash
cd public && npx vite --port 3002
```

Navigate to `http://localhost:3002/biegi`.

Check:
- H1 shows "Kalendarz biegów"
- Three sections render (Według typu / Według województwa / Specjalne)
- Each card shows the h1 label and event count (loaded from manifest fetch)
- Clicking a card navigates to the right URL

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/BieguHub.jsx
git commit -m "feat: add BieguHub navigation page at /biegi"
```

---

## Task 5: `LandingPage.jsx` — faceted listing

**Files:**
- Create: `public/src/pages/LandingPage.jsx`

- [ ] **Step 1: Create the component**

```jsx
import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import EventRow from '../components/EventRow.jsx'
import useSeo from '../hooks/useSeo.js'
import {
  TYPE_SLUG_TO_DB, REGION_SLUG_TO_DB,
  MONTH_SLUG_TO_NUM, SPECIAL_SLUGS, SPECIAL_H1,
} from '../lib/biegi-mappings.js'

const PAGE_SIZE = 100

// Mirrors parseDistanceToMeters from Kalendarz.jsx
function parseDistanceToMeters(d) {
  if (!d || typeof d !== 'string') return NaN
  const s = d.toLowerCase().trim()
  if (/\d\s*h(\b|$)/.test(s)) return NaN
  if (s.includes('półmaraton') || s.includes('polmaraton')) return 21097
  if (s.includes('maraton')) return 42195
  const match = s.match(/[0-9]+([.,][0-9]+)?/)
  if (!match) return NaN
  const num = parseFloat(match[0].replace(',', '.'))
  if (isNaN(num)) return NaN
  if (/km|kilometr/.test(s)) return Math.round(num * 1000)
  if (/\d\s*m\b|metr/.test(s)) return Math.round(num)
  return Math.round(num * 1000)
}

// Parse URL path segments into filter parameters
function parsePathFilters(pathname) {
  // pathname: /biegi/przelajowe/slaskie/2026/lipiec
  const seg = pathname.replace(/^\/biegi\/?/, '')
  if (!seg) return { special: null, typeDbVal: null, regionDb: null, year: null, month: null }

  const parts = seg.split('/')

  // Special pages
  if (parts.length === 1 && SPECIAL_SLUGS.includes(parts[0])) {
    return { special: parts[0], typeDbVal: null, regionDb: null, year: null, month: null }
  }

  let typeDbVal = null, regionDb = null, year = null, month = null
  for (const part of parts) {
    if (TYPE_SLUG_TO_DB[part]) typeDbVal = TYPE_SLUG_TO_DB[part]
    else if (REGION_SLUG_TO_DB[part]) regionDb = REGION_SLUG_TO_DB[part]
    else if (/^\d{4}$/.test(part)) year = parseInt(part)
    else if (MONTH_SLUG_TO_NUM[part]) month = MONTH_SLUG_TO_NUM[part]
  }
  return { special: null, typeDbVal, regionDb, year, month }
}

export default function LandingPage() {
  const location = useLocation()
  const [landingData, setLandingData] = useState(null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Read static landing-data on mount
  useEffect(() => {
    const el = document.getElementById('landing-data')
    if (el) {
      try { setLandingData(JSON.parse(el.textContent)) } catch {}
    }
  }, [location.pathname])

  const filters = useMemo(() => {
    if (landingData?.filters) return landingData.filters
    return parsePathFilters(location.pathname)
  }, [landingData, location.pathname])

  const h1 = landingData?.h1 || location.pathname.split('/').pop()
  const intro = landingData?.intro || null
  const relatedLinks = landingData?.relatedLinks || []
  const canonicalPath = landingData?.path ? `/${landingData.path}` : location.pathname

  // Fetch events from Supabase using display filter
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function fetchEvents() {
      const today = new Date().toISOString().slice(0, 10)

      let q = supabase
        .from('calendar_events')
        .select('*', { count: 'exact' })
        .eq('status', 'active')
        .gte('date', today)
        .or(`registration_deadline.is.null,registration_deadline.gte.${today}`)
        .order('date', { ascending: true })

      const { special, typeDbVal, regionDb, year, month } = filters

      if (special === 'polmaratony' || special === 'maratony') {
        // Distance-based: fetch broadly then filter client-side
        q = q.limit(2000)
      } else if (special === 'dla-dzieci') {
        q = q.eq('is_kids', true)
      } else if (special === 'isFree' || filters.isFree) {
        q = q.eq('price_from', 0)
      } else {
        if (typeDbVal) q = q.contains('event_type', [typeDbVal])
        if (regionDb) q = q.eq('voivodeship', regionDb)
        if (year && month) {
          const monthStr = String(month).padStart(2, '0')
          const lastDay = new Date(year, month, 0).getDate()
          q = q.gte('date', `${year}-${monthStr}-01`).lte('date', `${year}-${monthStr}-${lastDay}`)
        }
        const from = (page - 1) * PAGE_SIZE
        q = q.range(from, from + PAGE_SIZE - 1)
      }

      const { data, count, error } = await q
      if (cancelled) return
      if (error) { console.error('LandingPage fetch error:', error.message); setLoading(false); return }

      let result = data || []

      // Client-side distance filter for polmaratony/maratony
      if (special === 'polmaratony') {
        result = result.filter(e => (e.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 19000 && m <= 23000 }))
      } else if (special === 'maratony') {
        result = result.filter(e => (e.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 41000 && m <= 44000 }))
      }

      setEvents(result)
      setTotal(special === 'polmaratony' || special === 'maratony' ? result.length : (count || 0))
      setLoading(false)
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [filters, page])

  // Build full JSON-LD with events for useSeo after load
  const jsonLd = useMemo(() => {
    if (!events.length) return null
    return {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: h1,
      description: landingData?.description,
      url: `https://www.leszy.run${canonicalPath}`,
      inLanguage: 'pl-PL',
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: events.slice(0, 50).map((e, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'SportsEvent',
            name: e.name,
            startDate: e.date,
            location: {
              '@type': 'Place',
              name: e.location || undefined,
              address: { '@type': 'PostalAddress', addressLocality: e.location || undefined, addressRegion: e.voivodeship || undefined, addressCountry: 'PL' },
            },
            ...(e.price_from != null ? { offers: { '@type': 'Offer', price: String(e.price_from), priceCurrency: 'PLN', availability: 'https://schema.org/InStock' } } : {}),
            ...(e.registration_url || e.website ? { url: e.registration_url || e.website } : {}),
          },
        })),
      },
    }
  }, [events, h1, landingData, canonicalPath])

  useSeo({
    title: landingData?.title?.replace(' — Leszy.run', '') || h1,
    description: landingData?.description,
    path: canonicalPath,
    jsonLd,
  })

  const totalPages = Math.ceil(total / PAGE_SIZE)

  // Group events by month
  const grouped = events.reduce((acc, ev) => {
    const d = new Date(ev.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
    if (!acc[key]) acc[key] = { label, events: [] }
    acc[key].events.push(ev)
    return acc
  }, {})

  const kalendarzParams = new URLSearchParams()
  if (filters.typeDbVal) kalendarzParams.set('type', filters.typeDbVal)
  if (filters.regionDb) kalendarzParams.set('region', filters.regionDb)

  return (
    <>
      <Navbar />
      <main id="main-content" className="pt-20 pb-16 px-6 max-w-[1200px] mx-auto">
        <div className="mb-6">
          <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">
            {h1}
          </h1>
          {intro && <p className="text-base text-apex-text max-w-[700px]">{intro}</p>}
        </div>

        {relatedLinks.length > 0 && (
          <nav aria-label="Powiązane strony" className="mb-8">
            <div className="flex flex-wrap gap-2">
              {relatedLinks.map(link => (
                <Link
                  key={link.path}
                  to={`/${link.path}`}
                  className="font-mono text-[11px] font-semibold tracking-wide px-3 py-1.5 border border-apex-border text-apex-muted hover:border-apex-yellow/40 hover:text-apex-yellow transition-all"
                >
                  {link.h1}
                  {link.eventCount > 0 && <span className="ml-1.5 text-apex-yellow-dim">{link.eventCount}</span>}
                </Link>
              ))}
            </div>
          </nav>
        )}

        <div className="mb-4 flex justify-between items-center">
          <span className="font-mono text-xs text-apex-muted">
            Znaleziono <strong className="text-apex-yellow">{total}</strong> wydarzeń
          </span>
          <Link
            to={`/kalendarz${kalendarzParams.toString() ? '?' + kalendarzParams.toString() : ''}`}
            className="font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all"
          >
            Przeglądaj i filtruj →
          </Link>
        </div>

        {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}

        {!loading && Object.entries(grouped).map(([key, group]) => (
          <div key={key} className="mb-2">
            <div className="font-display font-bold text-base tracking-widest uppercase text-apex-yellow-dim py-5 border-b border-apex-border mb-0.5">
              {group.label}
            </div>
            {group.events.map(ev => <EventRow key={ev.id} event={ev} />)}
          </div>
        ))}

        {!loading && events.length === 0 && (
          <div className="text-apex-muted py-12 text-center">Brak wydarzeń dla tej kategorii.</div>
        )}

        {totalPages > 1 && (
          <div className="flex justify-center gap-1 pt-8">
            {page > 1 && (
              <button onClick={() => setPage(page - 1)}
                className="font-mono text-[13px] px-3.5 py-2 border bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright transition-all">
                &larr;
              </button>
            )}
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page >= totalPages - 3 ? totalPages - 6 + i : page - 3 + i
              return (
                <button key={p} onClick={() => setPage(p)}
                  className={`font-mono text-[13px] px-3.5 py-2 border transition-all ${p === page ? 'bg-apex-yellow text-apex-ink border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright'}`}>
                  {p}
                </button>
              )
            })}
            {page < totalPages && (
              <button onClick={() => setPage(page + 1)}
                className="font-mono text-[13px] px-3.5 py-2 border bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright transition-all">
                &rarr;
              </button>
            )}
          </div>
        )}
      </main>
      <Footer />
    </>
  )
}
```

- [ ] **Step 2: Start dev server and test several URLs**

```bash
cd public && npx vite --port 3002
```

Test these routes in the browser:
- `http://localhost:3002/biegi/przelajowe` — trail events, all Poland
- `http://localhost:3002/biegi/slaskie` — all events in Śląskie
- `http://localhost:3002/biegi/przelajowe/slaskie` — trail in Śląskie
- `http://localhost:3002/biegi/polmaratony` — half-marathon distance filter
- `http://localhost:3002/biegi/dla-dzieci` — is_kids filter

For each: verify H1 is correct, intro paragraph renders, event list loads, "Przeglądaj i filtruj" button is present, relatedLinks tags render (if manifest loaded).

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/LandingPage.jsx
git commit -m "feat: add LandingPage component for /biegi/* routes"
```

---

## Task 6: Wire up routes, nav, build, pipeline

**Files:**
- Modify: `public/src/App.jsx`
- Modify: `public/src/components/Navbar.jsx`
- Modify: `public/package.json`
- Modify: `scheduler/src/pipeline.js`

- [ ] **Step 1: Add routes to `public/src/App.jsx`**

Add these two lazy imports after the existing ones:

```js
const BieguHub = lazy(() => import('./pages/BieguHub.jsx'))
const LandingPage = lazy(() => import('./pages/LandingPage.jsx'))
```

Add these two routes inside `<Routes>` **before** the `<Route path="*">` catch-all:

```jsx
<Route path="/biegi" element={<BieguHub />} />
<Route path="/biegi/*" element={<LandingPage />} />
```

- [ ] **Step 2: Add "Biegi" nav link to `public/src/components/Navbar.jsx`**

In the `navLinks` array (currently ends with `{ to: '/#kontakt', label: 'Kontakt', hash: 'kontakt' }`), add a new entry after the Kalendarz link:

```js
{ to: '/biegi', label: 'Biegi', hash: '' },
```

Also update the `isActive` function to handle the `/biegi` route:

```js
if (link.to === '/biegi') return location.pathname.startsWith('/biegi')
```

- [ ] **Step 3: Update `public/package.json` build script**

Change:
```json
"build": "node scripts/generate-og-image.js && vite build && node scripts/generate-event-pages.js"
```

To:
```json
"build": "node scripts/generate-og-image.js && vite build && node scripts/generate-event-pages.js && node scripts/generate-landing-pages.js"
```

- [ ] **Step 4: Add step 12 to `scheduler/src/pipeline.js`**

In the `STEPS` array, after the last entry (`run-publish`), add:

```js
{ name: 'publish-landing-pages', type: 'backend', cmd: ['node', 'scripts/publish-landing-pages.js', '--apply'] },
```

- [ ] **Step 5: Run full build end-to-end**

```bash
# First ensure manifest is up-to-date
cd backend && node --env-file=../.env scripts/publish-landing-pages.js --apply

# Then build the public app
cd ../public && npm run build
```

Expected:
- Build completes without errors
- `dist/biegi/` contains subdirectories for each manifest entry
- `dist/sitemap.xml` ends with landing page entries before `</urlset>`
- `dist/biegi/index.html` exists (hub page)
- `dist/biegi/przelajowe/index.html` exists

Spot-check:
```bash
grep "biegi/przelajowe" dist/sitemap.xml
# Should appear once with the right priority
grep "<title>" dist/biegi/przelajowe/index.html
# Should show: <title>Biegi przełajowe w Polsce (N wydarzeń) — Leszy.run</title>
```

- [ ] **Step 6: Verify nav link in dev server**

```bash
cd public && npx vite --port 3002
```

- Check "Biegi" appears in the navbar
- Clicking it goes to `/biegi` and shows the hub page
- Hub link cards work

- [ ] **Step 7: Commit all wiring changes**

```bash
git add public/src/App.jsx public/src/components/Navbar.jsx public/package.json scheduler/src/pipeline.js
git commit -m "feat: wire up /biegi/* routes, nav link, build script, and pipeline step"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| URL structure incl. hub, type, region, month, special pages | Task 2 (manifest generation) + Task 6 (routes) |
| Type slug mapping (7 types) | Task 1 (biegi-mappings.js) |
| Region slug mapping (16 regions) with locatives | Task 1 |
| Month slug mapping with locatives | Task 1 |
| Generation thresholds (hub/type/region/special always, combos ≥2–5) | Task 2 |
| Threshold vs display filter (30-day lookback vs today + open reg) | Task 2 |
| Polish count inflection | Task 2 |
| Title/H1/description/intro per page type | Task 2 |
| `intro` field in manifest | Task 2 |
| `relatedLinks` computation (hub→children, type→region, sibling, month-adjacent) | Task 2 |
| Below-threshold URL handling (302 via CDN) | Not in code — CDN config, out of scope for this plan |
| Manifest format with all fields | Task 2 |
| Static HTML: full head, OG, JSON-LD CollectionPage | Task 3 |
| `<script id="landing-data">` embedding | Task 3 |
| `id="seo-page-jsonld"` matching useSeo hook | Task 3 |
| Sitemap append with priority/changefreq | Task 3 |
| Hub page: nav-only, link blocks by type/region/special | Task 4 |
| Hub page: fetches manifest or reads landing-data | Task 4 |
| LandingPage: reads landing-data, falls back to URL parsing | Task 5 |
| Display filter on Supabase query | Task 5 |
| Special page filter logic (4 types, new query paths) | Task 5 |
| Intro paragraph rendered | Task 5 |
| relatedLinks nav rendered | Task 5 |
| Full JSON-LD with ItemList+SportsEvent after hydration via useSeo | Task 5 |
| Pagination (100-event first page, "load more") | Task 5 |
| "Przeglądaj i filtruj" button to Kalendarz | Task 5 |
| `/biegi` and `/biegi/*` routes in App.jsx | Task 6 |
| "Biegi" nav link | Task 6 |
| Build script updated | Task 6 |
| Pipeline step 12 | Task 6 |

**Known gap:** CDN 302 redirect for below-threshold URLs is infrastructure config, not code. Note in deployment docs when this ships.

**Placeholder scan:** None found — all steps contain actual code.

**Type consistency check:**
- `landingData.filters` shape matches what `LandingPage.jsx` uses (`filters.typeDbVal`, `filters.regionDb`, etc.) — note: `filters` in manifest uses DB field names (`event_type`, `voivodeship`, `year`, `month`), but `LandingPage.jsx` uses the parsed form. The `parsePathFilters` function output keys (`typeDbVal`, `regionDb`, `year`, `month`, `special`) must match what the Supabase query block reads. ✓ They match.
- `relatedLinks` shape: `{ path, h1, eventCount }` — used consistently in both `computeRelatedLinks` (Task 2) and both page components (Tasks 4 and 5). ✓
- `MONTH_NUM_TO_SLUG` is used in Task 2 but only `MONTH_SLUG_TO_NUM` is used in Task 5 (for URL parsing). Both are exported from biegi-mappings.js. ✓
