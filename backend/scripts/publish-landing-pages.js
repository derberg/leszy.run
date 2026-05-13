// Usage: cd backend && node --env-file=../.env scripts/publish-landing-pages.js [--apply]
// Generates public/public/listy/.manifest.json from calendar_events Supabase data.
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
  slugifyCity, CITY_LOCATIVE, CITY_BLOCKLIST,
} from './lib/biegi-mappings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BIEGI_DIR = resolve(PROJECT_ROOT, 'public/public/listy')
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
    const spNoun = { polmaratony: 'półmaratonów', maratony: 'maratonów', 'dla-dzieci': 'biegów dla dzieci', darmowe: 'darmowych biegów', 'ostatnia-szansa': 'biegów z kończącymi się zapisami' }[special]
    const regionPart = regionSlug ? ` ${REGION_LOCATIVE[regionSlug]}` : ' w Polsce'
    const monthPart = year && month ? ` ${MONTH_LOCATIVE[month]} ${year}` : ''
    return `${count} ${spNoun}${regionPart}${monthPart}. ${SPECIAL_SECONDARY_KW[special]}. Zapisy, dystanse, ceny.`
  }
  const nounGen = typeSlug ? TYPE_NOUN_GEN[typeSlug] : 'biegów'
  const secKw = typeSlug ? ` ${TYPE_SECONDARY_KW[typeSlug]}.` : ''
  const regionPart = regionSlug ? ` ${REGION_LOCATIVE[regionSlug]}` : ' w Polsce'
  const monthPart = year && month ? ` ${MONTH_LOCATIVE[month]} ${year}` : ''
  return `${count} ${nounGen}${regionPart}${monthPart}.${secKw} Zapisy, dystanse, ceny.`
}

function buildIntro(typeSlug, regionSlug, year, month, count, distRange, special) {
  const yr = year || new Date().getFullYear()
  const dist = distRange && distRange.min !== distRange.max ? `, od ${distRange.min} km do ${distRange.max} km` : ''
  const regionPart = regionSlug ? ` ${REGION_LOCATIVE[regionSlug]}` : ' w Polsce'
  if (special === 'polmaratony') return `${count} półmaratonów${regionPart} w ${yr} roku. Dystans 21 km.`
  if (special === 'maratony') return `${count} maratonów${regionPart} w ${yr} roku. Dystans 42 km.`
  if (special === 'dla-dzieci') return `${count} biegów dla dzieci${regionPart} w ${yr} roku. Krótkie dystanse dla najmłodszych biegaczy.`
  if (special === 'darmowe') return `${count} darmowych biegów${regionPart} w ${yr} roku. Bezpłatny udział, bez opłaty startowej.`
  if (special === 'ostatnia-szansa') return `${count} biegów${regionPart} z zapisami kończącymi się w ciągu 14 dni.`
  const noun = typeSlug ? TYPE_H1_NOUN[typeSlug].toLowerCase() : 'listy'
  return `${count} ${noun}${regionPart} w ${yr} roku${dist}.`.trim()
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

function matchesFacet(event, { typeDbVal, regionDb, year, month, special, city }) {
  if (special === 'polmaratony') {
    if (!(event.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 19000 && m <= 23000 })) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'maratony') {
    if (!(event.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 41000 && m <= 44000 })) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'dla-dzieci') {
    if (!(Array.isArray(event.event_type) ? event.event_type : []).includes('dzieci')) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'darmowe') {
    if (event.price_from !== 0) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (special === 'ostatnia-szansa') {
    if (!event.registration_deadline) return false
    const daysUntil = (new Date(event.registration_deadline) - new Date()) / 86400000
    if (!(daysUntil >= 0 && daysUntil <= 14)) return false
    if (regionDb && event.voivodeship !== regionDb) return false
    return true
  }
  if (typeDbVal && !getEventTypes(event).includes(typeDbVal)) return false
  if (regionDb && event.voivodeship !== regionDb) return false
  if (city) {
    const eventCity = event.location ? event.location.split(/[\n,]/)[0].replace(/\s+/g, ' ').trim() : null
    if (!eventCity || eventCity.toLowerCase() !== city.toLowerCase()) return false
  }
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
      if (!isNaN(m) && m >= 1000) { min = Math.min(min, m); max = Math.max(max, m) }
    }
  }
  if (min === Infinity) return null
  return { min: Math.round(min / 1000), max: Math.round(max / 1000) }
}

function computeMetadata(displayEvents, facet) {
  const matched = displayEvents.filter(e => matchesFacet(e, facet))
  return { count: matched.length, distRange: computeDistRange(matched) }
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
  const seg = path.replace('listy/', '')
  const parts = seg === '' ? [] : seg.split('/')

  // Hub
  if (path === 'listy') {
    return [
      ...typeSlugs.map(t => manifestRef(manifest, `listy/${t}`)),
      ...SPECIAL_SLUGS.map(s => manifestRef(manifest, `listy/${s}`)),
      ...regionSlugs.map(r => manifestRef(manifest, `listy/${r}`)),
    ].filter(Boolean)
  }

  // Special pages (national)
  if (parts.length === 1 && SPECIAL_SLUGS.includes(parts[0])) {
    const sp = parts[0]
    const regionalLinks = regionSlugs
      .map(r => manifestRef(manifest, `listy/${sp}/${r}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
    return [manifestRef(manifest, 'listy'), ...regionalLinks].filter(Boolean)
  }

  // Special + region
  if (parts.length === 2 && SPECIAL_SLUGS.includes(parts[0]) && REGION_SLUG_TO_DB[parts[1]]) {
    const [sp, regionSlug] = parts
    const siblingRegions = regionSlugs
      .filter(r => r !== regionSlug)
      .map(r => manifestRef(manifest, `listy/${sp}/${r}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, 5)
    return [
      manifestRef(manifest, `listy/${sp}`),
      manifestRef(manifest, `listy/${regionSlug}`),
      ...siblingRegions,
    ].filter(Boolean)
  }

  // Type-only
  if (parts.length === 1 && TYPE_SLUG_TO_DB[parts[0]]) {
    const typeSlug = parts[0]
    const typeRegionLinks = regionSlugs
      .map(r => manifestRef(manifest, `listy/${typeSlug}/${r}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
    const monthLinks = nextNMonths(today, 3)
      .map(({ year, month }) => manifestRef(manifest, `listy/${typeSlug}/${year}/${MONTH_NUM_TO_SLUG[month]}`))
      .filter(Boolean)
    return [manifestRef(manifest, 'listy'), ...typeRegionLinks, ...monthLinks].filter(Boolean)
  }

  // Region-only
  if (parts.length === 1 && REGION_SLUG_TO_DB[parts[0]]) {
    const regionSlug = parts[0]
    const regionTypeLinks = typeSlugs
      .map(t => manifestRef(manifest, `listy/${t}/${regionSlug}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
    const monthLinks = nextNMonths(today, 3)
      .map(({ year, month }) => manifestRef(manifest, `listy/${regionSlug}/${year}/${MONTH_NUM_TO_SLUG[month]}`))
      .filter(Boolean)
    return [manifestRef(manifest, 'listy'), ...regionTypeLinks, ...monthLinks].filter(Boolean)
  }

  // City page (single slug not matching type/region/special)
  if (parts.length === 1) {
    return [manifestRef(manifest, 'listy')].filter(Boolean)
  }

  // Type + region
  if (parts.length === 2 && TYPE_SLUG_TO_DB[parts[0]] && REGION_SLUG_TO_DB[parts[1]]) {
    const [typeSlug, regionSlug] = parts
    const siblingRegions = regionSlugs
      .filter(r => r !== regionSlug)
      .map(r => manifestRef(manifest, `listy/${typeSlug}/${r}`))
      .filter(Boolean)
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, 5)
    const monthLinks = nextNMonths(today, 2)
      .map(({ year, month }) => manifestRef(manifest, `listy/${typeSlug}/${regionSlug}/${year}/${MONTH_NUM_TO_SLUG[month]}`))
      .filter(Boolean)
    return [
      manifestRef(manifest, `listy/${typeSlug}`),
      manifestRef(manifest, `listy/${regionSlug}`),
      ...siblingRegions,
      ...monthLinks,
    ].filter(Boolean)
  }

  // Month combo — link to parent + adjacent months
  const yearIdx = parts.findIndex(p => /^\d{4}$/.test(p))
  if (yearIdx >= 0) {
    const year = parseInt(parts[yearIdx])
    const month = MONTH_SLUG_TO_NUM[parts[yearIdx + 1]]
    const parentPath = yearIdx === 0 ? 'listy' : `listy/${parts.slice(0, yearIdx).join('/')}`
    const prefix = parts.slice(0, yearIdx)
    const prevM = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 }
    const nextM = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
    const prevPath = `listy/${[...prefix, String(prevM.y), MONTH_NUM_TO_SLUG[prevM.m]].join('/')}`
    const nextPath = `listy/${[...prefix, String(nextM.y), MONTH_NUM_TO_SLUG[nextM.m]].join('/')}`
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

  function addEntry({ path, filters, typeSlug = null, regionSlug = null, year = null, month = null, special = null, city = null, priority, changefreq }) {
    const facet = {
      typeDbVal: typeSlug ? TYPE_SLUG_TO_DB[typeSlug] : null,
      regionDb: regionSlug ? REGION_SLUG_TO_DB[regionSlug] : null,
      year, month, special, city,
    }
    const { count, distRange } = computeMetadata(displayEvents, facet)
    let h1, title, description, intro

    if (path === 'listy') {
      h1 = `Biegi w Polsce — kalendarz biegów ${currentYear}`
      title = `${h1} — Leszy.run`
      description = `Kalendarz biegów w Polsce ${currentYear}. Biegi przełajowe, uliczne, ultramaratony, nordic walking i więcej. Sprawdź pełny kalendarz według typu i województwa.`
      intro = `${displayEvents.length} biegów w Polsce w ${currentYear} roku — trailowe, uliczne, ultramaratony i więcej.`
    } else if (city) {
      const cityLoc = CITY_LOCATIVE[city] || `w ${city}`
      h1 = `Biegi ${cityLoc}`
      title = `${h1} (${inflectCount(count)}) — Leszy.run`
      description = `${count} biegów ${cityLoc}. Biegi uliczne, przełajowe, nordic walking i inne. Zapisy, dystanse, ceny.`
      intro = `${count} biegów ${cityLoc} w ${currentYear} roku.`
    } else if (special && regionSlug) {
      const SPECIAL_H1_NOUN = {
        polmaratony: 'Półmaratony', maratony: 'Maratony', 'dla-dzieci': 'Biegi dla dzieci',
        darmowe: 'Darmowe biegi', 'ostatnia-szansa': 'Biegi',
      }
      const locative = REGION_LOCATIVE[regionSlug]
      h1 = special === 'ostatnia-szansa'
        ? `Biegi ${locative} — ostatnia szansa na zapis`
        : `${SPECIAL_H1_NOUN[special]} ${locative}`
      title = `${h1} (${inflectCount(count)}) — Leszy.run`
      description = buildDescription(typeSlug, regionSlug, year, month, count, special)
      intro = buildIntro(typeSlug, regionSlug, year, month, count, distRange, special)
    } else {
      h1 = buildH1(typeSlug, regionSlug, year, month)
      title = special ? `${SPECIAL_H1[special]} (${inflectCount(count)}) — Leszy.run` : buildTitle(h1, count)
      if (special) h1 = SPECIAL_H1[special]
      description = buildDescription(typeSlug, regionSlug, year, month, count, special)
      intro = buildIntro(typeSlug, regionSlug, year, month, count, distRange, special)
    }

    manifest[path] = {
      path, filters: facet, h1, title, description, intro, eventCount: count,
      canonicalUrl: `${BASE_URL}/${path}`,
      sitemapPriority: priority, sitemapChangefreq: changefreq,
      relatedLinks: [],
    }
  }

  // Hub
  addEntry({ path: 'listy', filters: {}, priority: '0.9', changefreq: 'daily' })

  // Type-only (always)
  for (const ts of typeSlugs) {
    addEntry({ path: `listy/${ts}`, filters: { event_type: TYPE_SLUG_TO_DB[ts] }, typeSlug: ts, priority: '0.8', changefreq: 'weekly' })
  }

  // Region-only (always)
  for (const rs of regionSlugs) {
    addEntry({ path: `listy/${rs}`, filters: { voivodeship: REGION_SLUG_TO_DB[rs] }, regionSlug: rs, priority: '0.8', changefreq: 'weekly' })
  }



  // Special pages (always)
  const specialFilters = {
    polmaratony: { distanceType: 'halfmarathon' }, maratony: { distanceType: 'marathon' },
    'dla-dzieci': { isKids: true }, darmowe: { isFree: true }, 'ostatnia-szansa': { deadlineDays: 14 },
  }
  for (const sp of SPECIAL_SLUGS) {
    addEntry({ path: `listy/${sp}`, filters: specialFilters[sp], special: sp, priority: '0.8', changefreq: 'daily' })
  }

  // Special + region (≥3 threshold)
  for (const sp of SPECIAL_SLUGS) {
    for (const rs of regionSlugs) {
      if (countThreshold({ special: sp, regionDb: REGION_SLUG_TO_DB[rs] }) < 3) continue
      addEntry({ path: `listy/${sp}/${rs}`, special: sp, regionSlug: rs, priority: '0.7', changefreq: 'daily' })
    }
  }

  // Type + region (≥3 threshold)
  for (const ts of typeSlugs) {
    for (const rs of regionSlugs) {
      if (countThreshold({ typeDbVal: TYPE_SLUG_TO_DB[ts], regionDb: REGION_SLUG_TO_DB[rs] }) < 3) continue
      addEntry({ path: `listy/${ts}/${rs}`, filters: { event_type: TYPE_SLUG_TO_DB[ts], voivodeship: REGION_SLUG_TO_DB[rs] }, typeSlug: ts, regionSlug: rs, priority: '0.7', changefreq: 'weekly' })
    }
  }

  // Month-only (≥5 threshold)
  for (const { year, month } of yearMonths) {
    if (countThreshold({ year, month }) < 5) continue
    addEntry({ path: `listy/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { year, month }, year, month, priority: '0.6', changefreq: 'daily' })
  }

  // Type + month (≥3 threshold)
  for (const ts of typeSlugs) {
    for (const { year, month } of yearMonths) {
      if (countThreshold({ typeDbVal: TYPE_SLUG_TO_DB[ts], year, month }) < 3) continue
      addEntry({ path: `listy/${ts}/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { event_type: TYPE_SLUG_TO_DB[ts], year, month }, typeSlug: ts, year, month, priority: '0.6', changefreq: 'daily' })
    }
  }

  // Region + month (≥3 threshold)
  for (const rs of regionSlugs) {
    for (const { year, month } of yearMonths) {
      if (countThreshold({ regionDb: REGION_SLUG_TO_DB[rs], year, month }) < 3) continue
      addEntry({ path: `listy/${rs}/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { voivodeship: REGION_SLUG_TO_DB[rs], year, month }, regionSlug: rs, year, month, priority: '0.6', changefreq: 'daily' })
    }
  }

  // Type + region + month (≥3 threshold)
  for (const ts of typeSlugs) {
    for (const rs of regionSlugs) {
      for (const { year, month } of yearMonths) {
        if (countThreshold({ typeDbVal: TYPE_SLUG_TO_DB[ts], regionDb: REGION_SLUG_TO_DB[rs], year, month }) < 3) continue
        addEntry({ path: `listy/${ts}/${rs}/${year}/${MONTH_NUM_TO_SLUG[month]}`, filters: { event_type: TYPE_SLUG_TO_DB[ts], voivodeship: REGION_SLUG_TO_DB[rs], year, month }, typeSlug: ts, regionSlug: rs, year, month, priority: '0.6', changefreq: 'daily' })
      }
    }
  }

  // City pages (> 2 display events from the same primary city)
  const cityCount = {}
  for (const e of displayEvents) {
    if (!e.location) continue
    const city = e.location.split(/[\n,]/)[0].replace(/\s+/g, ' ').trim()
    if (city && !CITY_BLOCKLIST.has(city)) cityCount[city] = (cityCount[city] || 0) + 1
  }
  for (const [city, count] of Object.entries(cityCount)) {
    if (count <= 2) continue
    const citySlug = slugifyCity(city)
    const path = `listy/${citySlug}`
    if (manifest[path]) continue // don't overwrite type/region/special pages
    addEntry({ path, filters: { city }, city, priority: '0.7', changefreq: 'weekly' })
  }
  console.log(`City pages: ${Object.values(cityCount).filter(c => c > 2).length} cities with >2 events`)

  // Second pass: fill relatedLinks
  for (const path of Object.keys(manifest)) {
    manifest[path].relatedLinks = computeRelatedLinks(manifest, path, today)
  }

  // Summary
  const total = Object.keys(manifest).length
  const byType = {}
  for (const path of Object.keys(manifest)) {
    const parts = path.replace('listy', '').replace(/^\//, '').split('/').filter(Boolean)
    const key = parts.length === 0 ? 'hub' : parts.length === 1 && SPECIAL_SLUGS.includes(parts[0]) ? 'special' : parts.length === 1 && TYPE_SLUG_TO_DB[parts[0]] ? 'type' : parts.length === 1 && REGION_SLUG_TO_DB[parts[0]] ? 'region' : parts.length === 1 ? 'city' : parts.length === 2 && SPECIAL_SLUGS.includes(parts[0]) && REGION_SLUG_TO_DB[parts[1]] ? 'special+region' : parts.length === 2 && TYPE_SLUG_TO_DB[parts[0]] && REGION_SLUG_TO_DB[parts[1]] ? 'type+region' : parts.length === 2 ? 'month' : parts.length === 3 ? 'type+month or region+month' : 'type+region+month'
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
