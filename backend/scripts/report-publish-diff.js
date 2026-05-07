// Generate a CSV report of every calendar_events row whose data differs
// from the scraper_all row it's linked to. One row per event, one column per
// changeable field — empty when no change, "<old> → <new>" when different.
//
// Usage: cd backend && node --env-file=../.env scripts/report-publish-diff.js
// Output: backend/logs/publish-diff-<timestamp>.csv
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const PAGE = 1000

async function fetchAll(table, select, filters = q => q) {
  const out = []
  let from = 0
  while (true) {
    const { data, error } = await filters(supabase.from(table).select(select)).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return out
}

function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    const sa = [...a].sort(), sb = [...b].sort()
    return sa.every((v, i) => v === sb[i])
  }
  return a === b
}

function fmt(v) {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

function diff(label, oldV, newV) {
  if (oldV === newV) return ''
  if (Array.isArray(oldV) && Array.isArray(newV) && eq(oldV, newV)) return ''
  if (newV === null || newV === undefined) return ''  // never report "removing" data
  if (Array.isArray(newV) && newV.length === 0) return ''
  if (typeof newV === 'string' && !newV.trim()) return ''
  return `${fmt(oldV) || 'NULL'} → ${fmt(newV)}`
}

function csvCell(s) {
  if (s == null) return ''
  const str = String(s)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

async function main() {
  console.log('Fetching scraper_all + calendar_events…')
  const ce = await fetchAll(
    'calendar_events',
    'id, name, date, status, source, source_id, source_links, locked_fields, location, voivodeship, lat, lng, distances, event_type, registration_url, regulamin_url, website, price_from, price_to, registration_deadline'
  )
  const sa = await fetchAll(
    'scraper_all',
    'source, source_id, source_links, location, voivodeship, lat, lng, distances, event_types, event_type, is_kids, registration_url, regulamin_url, website, price_from, price_to, registration_deadline'
  )

  // Index scraper_all by every (source, source_id) pair (primary + source_links)
  const saByKey = new Map()
  for (const r of sa) {
    if (r.source && r.source_id) saByKey.set(`${r.source}:${r.source_id}`, r)
    for (const l of (r.source_links || [])) {
      if (l.source && l.source_id) saByKey.set(`${l.source}:${l.source_id}`, r)
    }
  }

  const rows = []
  let withChanges = 0
  for (const c of ce) {
    if (c.status === 'rejected') continue
    const keys = []
    if (c.source && c.source_id) keys.push(`${c.source}:${c.source_id}`)
    for (const l of (c.source_links || [])) {
      if (l.source && l.source_id) keys.push(`${l.source}:${l.source_id}`)
    }
    let saRow = null
    for (const k of keys) {
      if (saByKey.has(k)) { saRow = saByKey.get(k); break }
    }
    if (!saRow) continue

    // Build scraper_all-side normalized values
    const saDistArr = saRow.distances
      ? String(saRow.distances).split(',').map(d => d.trim()).filter(Boolean)
      : []
    let saTypes = saRow.event_types || (saRow.event_type ? [saRow.event_type] : []) || []
    if (!Array.isArray(saTypes)) saTypes = [saTypes]
    saTypes = saTypes.filter(Boolean)
    if (saRow.is_kids && !saTypes.includes('dzieci')) saTypes.push('dzieci')

    const d = {
      id: c.id,
      date: c.date,
      name: c.name,
      status: c.status,
      source: c.source,
      source_id: c.source_id,
      locked: (c.locked_fields || []).join('; '),
      location: diff('location', c.location, saRow.location),
      voivodeship: diff('voivodeship', c.voivodeship, saRow.voivodeship),
      lat: diff('lat', c.lat, saRow.lat),
      lng: diff('lng', c.lng, saRow.lng),
      distances: saDistArr.length && !eq(c.distances || [], saDistArr)
        ? `${fmt(c.distances)} → ${saDistArr.join(', ')}` : '',
      event_type: saTypes.length && !eq(c.event_type || [], saTypes)
        ? `${fmt(c.event_type)} → ${saTypes.join(', ')}` : '',
      registration_url: diff('registration_url', c.registration_url, saRow.registration_url),
      regulamin_url: diff('regulamin_url', c.regulamin_url, saRow.regulamin_url),
      website: diff('website', c.website, saRow.website),
      price_from: diff('price_from', c.price_from, saRow.price_from),
      price_to: diff('price_to', c.price_to, saRow.price_to),
      registration_deadline: diff('registration_deadline', c.registration_deadline, saRow.registration_deadline),
    }

    const changedFields = ['location','voivodeship','lat','lng','distances','event_type','registration_url','regulamin_url','website','price_from','price_to','registration_deadline']
      .filter(f => d[f])
    if (changedFields.length === 0) continue
    d.changed_fields = changedFields.join('; ')
    withChanges++
    rows.push(d)
  }

  rows.sort((a, b) => (a.date > b.date ? 1 : -1))

  // Counts by field
  const counts = {}
  for (const r of rows) {
    for (const f of r.changed_fields.split('; ')) {
      counts[f] = (counts[f] || 0) + 1
    }
  }

  const header = ['date','name','status','source','source_id','locked','changed_fields','location','voivodeship','lat','lng','distances','event_type','registration_url','regulamin_url','website','price_from','price_to','registration_deadline']
  const csv = [header.join(',')]
  for (const r of rows) {
    csv.push(header.map(h => csvCell(r[h] ?? '')).join(','))
  }

  mkdirSync('logs', { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join('logs', `publish-diff-${ts}.csv`)
  writeFileSync(outPath, csv.join('\n'), 'utf-8')

  console.log(`\nEvents with at least one differing field: ${withChanges}`)
  console.log(`\nLiczba zdarzeń per pole (field: count):`)
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(24)} ${n}`)
  }
  console.log(`\nCSV: ${outPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })
