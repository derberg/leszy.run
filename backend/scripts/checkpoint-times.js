#!/usr/bin/env node
// Checkpoint times straight from Supabase — the ONE view that is always complete.
//
// Why this exists: checkpoint_observations are written directly to Supabase by the
// Pi checkpoint-agent (RFID) and by the volunteer phone app (manual). The only path
// into a backend's local Postgres is the realtime subscription in
// src/sync/supabase.js, and realtime delivers INSERTs *as they happen* — it never
// backfills. So any window where that subscription is down (a backend restart
// mid-race is enough) leaves those observations permanently absent locally, and the
// admin race/results pages, which read the local DB, show nothing. Observed
// 2026-08-07: 23 observations in Supabase, 0 locally, zero realtime log lines for
// the whole race.
//
// This script never touches the local DB. It reads Supabase, which is the source of
// truth for observations, so it is correct regardless of sync state.
//
// Usage (from backend/):
//   node --env-file=../.env scripts/checkpoint-times.js                 # newest event with observations
//   node --env-file=../.env scripts/checkpoint-times.js nocny-zew-wilka # by slug
//   node --env-file=../.env scripts/checkpoint-times.js <event-uuid>    # by id
//   node --env-file=../.env scripts/checkpoint-times.js --missing       # also list runners with no reading
//   node --env-file=../.env scripts/checkpoint-times.js --csv           # CSV instead of a table

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run with --env-file=../.env)')
  process.exit(1)
}

const args = process.argv.slice(2)
const showMissing = args.includes('--missing')
const asCsv = args.includes('--csv')
const target = args.find((a) => !a.startsWith('--')) ?? null

// PostgREST caps a response at 1000 rows server-side, so every list read pages.
async function rest(path) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Range: `${from}-${from + 999}`,
      },
    })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
    const page = await res.json()
    out.push(...page)
    if (page.length < 1000) return out
  }
}

const hhmmss = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Warsaw' }) : '—'

async function resolveEvent() {
  if (target) {
    const byId = /^[0-9a-f-]{36}$/i.test(target)
    const rows = await rest(`events?${byId ? 'id' : 'slug'}=eq.${target}&select=id,name,slug,date`)
    if (!rows.length) throw new Error(`No event matching "${target}"`)
    return rows[0]
  }
  // No argument: the event whose checkpoints hold the most recent observation —
  // i.e. "the one you are timing right now", which is what you want mid-race.
  const obs = await rest('checkpoint_observations?select=checkpoint_id,observed_at&order=observed_at.desc&limit=1')
  if (!obs.length) throw new Error('No checkpoint observations exist at all. Pass an event slug explicitly.')
  const [cp] = await rest(`checkpoints?id=eq.${obs[0].checkpoint_id}&select=event_id`)
  const [ev] = await rest(`events?id=eq.${cp.event_id}&select=id,name,slug,date`)
  return ev
}

const ev = await resolveEvent()
const checkpoints = (await rest(`checkpoints?event_id=eq.${ev.id}&select=id,name,km_marker&order=km_marker`))
const participants = await rest(`participants?event_id=eq.${ev.id}&select=bib_number,first_name,last_name,category_id&order=bib_number`)
const categories = await rest(`categories?event_id=eq.${ev.id}&select=id,name`)
const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]))

if (!checkpoints.length) {
  console.log(`Event "${ev.name}" has no checkpoints.`)
  process.exit(0)
}

const cpIds = checkpoints.map((c) => c.id).join(',')
const obs = await rest(`checkpoint_observations?checkpoint_id=in.(${cpIds})&select=checkpoint_id,bib_number,observed_at,source&order=observed_at`)

// bib -> { cpId: { observed_at, source } }
const byBib = new Map()
for (const o of obs) {
  if (!byBib.has(o.bib_number)) byBib.set(o.bib_number, {})
  byBib.get(o.bib_number)[o.checkpoint_id] = o
}

const rows = participants
  .filter((p) => showMissing || byBib.has(p.bib_number))
  .map((p) => ({
    bib: p.bib_number,
    name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
    cat: catName[p.category_id] ?? '?',
    cells: checkpoints.map((c) => byBib.get(p.bib_number)?.[c.id] ?? null),
  }))

console.log(`\n${ev.name}  (${ev.date})   —  dane z Supabase, ${obs.length} odczytów\n`)

if (asCsv) {
  console.log(['nr', 'zawodnik', 'kategoria', ...checkpoints.flatMap((c) => [`${c.name}`, `${c.name}_source`])].join(','))
  for (const r of rows) {
    console.log([r.bib, `"${r.name}"`, `"${r.cat}"`, ...r.cells.flatMap((o) => [hhmmss(o?.observed_at), o?.source ?? ''])].join(','))
  }
} else {
  const w = { bib: 4, name: Math.max(12, ...rows.map((r) => r.name.length)), cat: Math.max(9, ...rows.map((r) => r.cat.length)) }
  const head = ['nr'.padStart(w.bib), 'zawodnik'.padEnd(w.name), 'kategoria'.padEnd(w.cat), ...checkpoints.map((c) => `${c.name}${c.km_marker ? ` (${Number(c.km_marker)}km)` : ''}`.padEnd(20))]
  console.log(head.join(' │ '))
  console.log('─'.repeat(head.join(' │ ').length))
  for (const r of rows) {
    const cells = r.cells.map((o) => (o ? `${hhmmss(o.observed_at)} ${o.source === 'manual' ? '(ręcznie)' : ''}`.trim() : '—').padEnd(20))
    console.log([String(r.bib).padStart(w.bib), r.name.padEnd(w.name), r.cat.padEnd(w.cat), ...cells].join(' │ '))
  }

  console.log('')
  for (const c of checkpoints) {
    const seen = obs.filter((o) => o.checkpoint_id === c.id)
    const manual = seen.filter((o) => o.source === 'manual').length
    console.log(`${c.name}: ${seen.length} odczytów (${seen.length - manual} RFID, ${manual} ręcznie) z ${participants.length} zapisanych`)
  }
  if (!showMissing) {
    const missing = participants.length - rows.length
    if (missing > 0) console.log(`\n${missing} zawodników bez żadnego odczytu — pokaż ich flagą --missing`)
  }
}
