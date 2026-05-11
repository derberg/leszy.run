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
  if (special === 'dla-dzieci') return (Array.isArray(event.event_type) ? event.event_type : []).includes('dzieci')
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

  // is_kids is not a column in calendar_events; publishToCalendar maps it to event_type=['dzieci']
  const SELECT = 'date,location,voivodeship,event_type,distances,price_from,registration_deadline'

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
