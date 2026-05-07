// Markdown variant of report-publish-diff.js
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const PAGE = 1000

async function fetchAll(table, select) {
  const out = []
  let from = 0
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + PAGE - 1)
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

// Treat lat/lng equal if the difference is below ~10 m (1e-4 degrees).
// Sub-mm differences are pure numeric/float64 round-trip noise, not real moves.
function coordEqual(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b
  return Math.abs(Number(a) - Number(b)) < 0.0001
}

function fmt(v) {
  if (v === null || v === undefined) return 'NULL'
  if (Array.isArray(v)) return v.join(', ') || 'NULL'
  return String(v)
}

function diffStr(oldV, newV) {
  if (newV === null || newV === undefined) return ''
  if (Array.isArray(newV) && newV.length === 0) return ''
  if (typeof newV === 'string' && !newV.trim()) return ''
  if (eq(oldV, newV)) return ''
  return `${fmt(oldV)} → ${fmt(newV)}`
}

function trunc(s, max = 60) {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function escapeMd(s) {
  if (!s) return ''
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

async function main() {
  console.log('Fetching…')
  const ce = await fetchAll(
    'calendar_events',
    'id, name, date, status, source, source_id, source_links, locked_fields, location, voivodeship, lat, lng, distances, event_type, registration_url, regulamin_url, website, price_from, price_to, registration_deadline'
  )
  const sa = await fetchAll(
    'scraper_all',
    'source, source_id, source_links, location, voivodeship, lat, lng, distances, event_types, event_type, is_kids, registration_url, regulamin_url, website, price_from, price_to, registration_deadline'
  )

  // Match ONLY by primary source+source_id. Cross-source matching via
  // source_links creates false-positive diffs because two scraper rows for
  // the same event can have different geocoder output / prices / URLs;
  // those are inter-source differences, not "data drift" within the same
  // source. The publish-update path uses primary match too, so this report
  // mirrors what the update would actually see.
  const saByPrimary = new Map()
  for (const r of sa) {
    if (r.source && r.source_id) saByPrimary.set(`${r.source}:${r.source_id}`, r)
  }

  const rows = []
  let unmatched = 0
  for (const c of ce) {
    if (c.status === 'rejected') continue
    if (!c.source || !c.source_id) continue
    const saRow = saByPrimary.get(`${c.source}:${c.source_id}`)
    if (!saRow) { unmatched++; continue }

    const saDistArr = saRow.distances
      ? String(saRow.distances).split(',').map(d => d.trim()).filter(Boolean)
      : []
    let saTypes = saRow.event_types || (saRow.event_type ? [saRow.event_type] : []) || []
    if (!Array.isArray(saTypes)) saTypes = [saTypes]
    saTypes = saTypes.filter(Boolean)
    if (saRow.is_kids && !saTypes.includes('dzieci')) saTypes.push('dzieci')

    const locked = new Set(Array.isArray(c.locked_fields) ? c.locked_fields : [])
    const fields = []
    const detail = {}
    function add(name, oldV, newV) {
      if (locked.has(name)) return
      const d = diffStr(oldV, newV)
      if (d) { fields.push(name); detail[name] = d }
    }
    add('location', c.location, saRow.location)
    add('voivodeship', c.voivodeship, saRow.voivodeship)
    if (!locked.has('lat') && !coordEqual(c.lat, saRow.lat) && saRow.lat !== null && saRow.lat !== undefined) {
      fields.push('lat'); detail.lat = `${fmt(c.lat)} → ${fmt(saRow.lat)}`
    }
    if (!locked.has('lng') && !coordEqual(c.lng, saRow.lng) && saRow.lng !== null && saRow.lng !== undefined) {
      fields.push('lng'); detail.lng = `${fmt(c.lng)} → ${fmt(saRow.lng)}`
    }
    if (!locked.has('distances') && saDistArr.length && !eq(c.distances || [], saDistArr)) {
      fields.push('distances'); detail.distances = `${fmt(c.distances)} → ${saDistArr.join(', ')}`
    }
    if (!locked.has('event_type') && saTypes.length && !eq(c.event_type || [], saTypes)) {
      fields.push('event_type'); detail.event_type = `${fmt(c.event_type)} → ${saTypes.join(', ')}`
    }
    add('registration_url', c.registration_url, saRow.registration_url)
    add('regulamin_url', c.regulamin_url, saRow.regulamin_url)
    add('website', c.website, saRow.website)
    add('price_from', c.price_from, saRow.price_from)
    add('price_to', c.price_to, saRow.price_to)
    add('registration_deadline', c.registration_deadline, saRow.registration_deadline)

    if (fields.length === 0) continue
    rows.push({
      date: c.date, name: c.name, status: c.status,
      source: c.source,
      changed: fields.join(', '),
      detail,
    })
  }

  rows.sort((a, b) => (a.date > b.date ? 1 : -1))

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync('logs', { recursive: true })

  // Compact table — one row per event, just shows which fields differ
  const compact = ['# Publish diff — compact', '', `Total: **${rows.length}** events with differences\n`]
  compact.push('| date | name | source | status | changed fields |')
  compact.push('|---|---|---|---|---|')
  for (const r of rows) {
    compact.push(`| ${r.date} | ${escapeMd(trunc(r.name, 50))} | ${r.source} | ${r.status} | ${r.changed} |`)
  }
  const compactPath = join('logs', `publish-diff-compact-${ts}.md`)
  writeFileSync(compactPath, compact.join('\n'), 'utf-8')

  // Detailed table — shows old → new for each changed field
  const detailed = ['# Publish diff — detailed', '', `Total: **${rows.length}** events with differences. Each row shows old → new for the differing fields only.\n`]
  detailed.push('| date | name | source | changes |')
  detailed.push('|---|---|---|---|')
  for (const r of rows) {
    const changes = Object.entries(r.detail)
      .map(([f, v]) => `**${f}**: ${escapeMd(trunc(v, 120))}`)
      .join('<br>')
    detailed.push(`| ${r.date} | ${escapeMd(trunc(r.name, 50))} | ${r.source} | ${changes} |`)
  }
  const detailedPath = join('logs', `publish-diff-detailed-${ts}.md`)
  writeFileSync(detailedPath, detailed.join('\n'), 'utf-8')

  console.log(`\nTotal events with differences (primary source match only): ${rows.length}`)
  console.log(`Calendar_events rows with no matching primary in scraper_all: ${unmatched}`)
  console.log(`\nMarkdown:`)
  console.log(`  compact:  ${compactPath}`)
  console.log(`  detailed: ${detailedPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })
