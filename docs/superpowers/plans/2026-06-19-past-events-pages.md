# Past Events Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let visitors find past leszy.run events from the landing page and view a statically-built per-event page with auto-derived stats and a link to the internal results.

**Architecture:** A read-only Supabase view (`event_results_summary`) aggregates per-event stats server-side. A host publish script reads it once and writes a committed manifest (`public/public/events/.manifest.json`). A build-time generate script bakes a static `dist/events/:slug/index.html` per past public event (stats + JSON-LD + results CTA). The `EventHub` React component hydrates from the embedded JSON; the landing page gets a compact "Minione wydarzenia" strip.

**Tech Stack:** Plain JavaScript (no TypeScript), Node ESM scripts, React 19 + Vite 6, `@supabase/supabase-js`, Tailwind v4 (OVERDRIVE theme tokens), Drizzle (schema only — no migration here since the view is Supabase-only).

## Global Constraints

- **JavaScript only** — no TypeScript, no `.ts`, no type annotations.
- **Supabase-only object** — the view is created via `mcp__supabase__apply_migration` only. No local Drizzle migration, no `schema.js` change.
- **DB-write-safety** — creating the view is DDL: state what it does and get explicit user confirmation before applying (read-only view, but still confirm).
- **Voivodeship/Polish text** — display text keeps Polish diacritics; this feature adds no URL slugs (event slugs already exist in `events.slug`).
- **UI theme** — use existing `apex-*` Tailwind tokens; buttons `rounded-none`, sharp edges, fonts `font-display`/`font-mono` per OVERDRIVE.
- **No `Co-Authored-By` trailers** in commits.
- **Manifest is committed** to the repo (like the kalendarz manifest).
- **Branch** — all work on `feat/past-events-pages` (already created).

---

### Task 1: Create the `event_results_summary` Supabase view

**Files:**
- Apply via: `mcp__supabase__apply_migration` (Supabase only — no local file)

**Interfaces:**
- Produces: a view `public.event_results_summary` with columns:
  - `event_id uuid`
  - `participants bigint` — count of `participants` rows for the event
  - `finishers bigint` — count of `results` with `status='finished'` from non-cancelled race runs of timed categories
  - `distances text[]` — distinct timed (`untimed=false`) category names, alphabetical
  - `fastest_ms bigint` — min `duration_ms` among finishers (null if none)
  - `fastest_name text` — `"First Last"` of that fastest finisher (null if none)

- [ ] **Step 1: State the change and get confirmation**

Tell the user verbatim:
> "I'm going to create a **read-only** Postgres view `event_results_summary` on Supabase via `apply_migration`. It only reads from `events`, `categories`, `race_runs`, `results`, `participants` and creates no table, writes no rows, and is reversible with `DROP VIEW`. OK to apply?"

Wait for explicit "yes"/"ok"/"proceed".

- [ ] **Step 2: Apply the migration**

Call `mcp__supabase__apply_migration` with name `create_event_results_summary_view` and this SQL:

```sql
create or replace view event_results_summary as
with timed_categories as (
  select c.id as category_id, c.event_id, c.name
  from categories c
  where c.untimed = false
),
live_runs as (
  select rr.id as race_run_id, tc.event_id
  from race_runs rr
  join timed_categories tc on tc.category_id = rr.category_id
  where rr.status <> 'cancelled'
),
finished as (
  select lr.event_id, r.duration_ms, r.participant_id
  from results r
  join live_runs lr on lr.race_run_id = r.race_run_id
  where r.status = 'finished'
),
fastest as (
  select distinct on (f.event_id)
    f.event_id, f.duration_ms, p.first_name, p.last_name
  from finished f
  join participants p on p.id = f.participant_id
  where f.duration_ms is not null
  order by f.event_id, f.duration_ms asc
)
select
  e.id as event_id,
  (select count(*) from participants pp where pp.event_id = e.id) as participants,
  (select count(*) from finished ff where ff.event_id = e.id) as finishers,
  coalesce(
    (select array_agg(tc.name order by tc.name)
       from (select distinct name from timed_categories where event_id = e.id) tc),
    '{}'
  ) as distances,
  fa.duration_ms as fastest_ms,
  case when fa.event_id is not null
       then btrim(concat(fa.first_name, ' ', fa.last_name))
  end as fastest_name
from events e
left join fastest fa on fa.event_id = e.id;
```

- [ ] **Step 3: Verify the view returns sane data**

Call `mcp__supabase__execute_sql` (read-only):

```sql
select s.event_id, e.name, e.date, e.visibility,
       s.participants, s.finishers, s.distances, s.fastest_ms, s.fastest_name
from event_results_summary s
join events e on e.id = s.event_id
where e.visibility = 'public' and e.date < current_date::text
order by e.date desc;
```

Expected: one row per past public event. Sanity-check one known event: `finishers <= participants`, `distances` non-empty for a normal race, `fastest_ms` populated when `finishers > 0`.

- [ ] **Step 4: Spot-check against the live Results page**

For one event from Step 3, open `https://www.leszy.run/events/<slug>/results` and confirm the finisher count and the fastest time roughly match the view's `finishers` / `fastest_ms` (`fastest_ms` ÷ 1000 = seconds). Note any mismatch before proceeding — a mismatch means the cancelled-run / untimed filter needs revisiting.

- [ ] **Step 5: Commit (documentation marker only)**

No file changed yet. Skip commit; the view is recorded in Supabase. Documentation commit happens in Task 6.

---

### Task 2: `publish-leszyrun-events.js` — write the committed manifest

**Files:**
- Create: `backend/scripts/publish-leszyrun-events.js`
- Output (written with `--apply`): `public/public/events/.manifest.json`

**Interfaces:**
- Consumes: the `event_results_summary` view (Task 1) + `events` table.
- Produces: `public/public/events/.manifest.json`, an object keyed by `events.slug`. Each value:
  ```js
  {
    id, name, slug, date,      // strings from events
    location,                  // string|null
    stats: {
      participants,            // number
      finishers,               // number
      distances,               // string[]
      fastest_ms,              // number|null
      fastest_name,            // string|null
    }
  }
  ```
  Only **past** (`date < today`) **public** (`visibility='public'`) events are included.

- [ ] **Step 1: Write the script**

Create `backend/scripts/publish-leszyrun-events.js`:

```js
// Usage: cd backend && node --env-file=../.env scripts/publish-leszyrun-events.js [--apply]
// Reads the event_results_summary view + events table and writes a committed manifest of
// PAST, PUBLIC leszy.run events with baked stats, consumed by
// public/scripts/generate-leszyrun-event-pages.js at build time.
// Dry run by default — use --apply to write the manifest.

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const EVENTS_DIR = resolve(PROJECT_ROOT, 'public/public/events')
const MANIFEST_PATH = resolve(EVENTS_DIR, '.manifest.json')

const dryRun = !process.argv.includes('--apply')

async function main() {
  if (dryRun) console.log('=== DRY RUN (use --apply to write the manifest) ===\n')

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_ANON_KEY')
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  const today = new Date().toISOString().slice(0, 10)

  // 1. Past public events
  const { data: events, error: evErr } = await supabase
    .from('events')
    .select('id, name, slug, date, location, visibility')
    .eq('visibility', 'public')
    .lt('date', today)
    .order('date', { ascending: false })
  if (evErr) { console.error('events fetch error:', evErr.message); process.exit(1) }

  if (!events || events.length === 0) {
    console.log('No past public events found. Writing empty manifest.')
  }

  // 2. Stats for those events
  const ids = (events || []).map(e => e.id)
  let statsById = {}
  if (ids.length > 0) {
    const { data: stats, error: stErr } = await supabase
      .from('event_results_summary')
      .select('event_id, participants, finishers, distances, fastest_ms, fastest_name')
      .in('event_id', ids)
    if (stErr) { console.error('summary fetch error:', stErr.message); process.exit(1) }
    statsById = Object.fromEntries((stats || []).map(s => [s.event_id, s]))
  }

  // 3. Build manifest keyed by slug
  const manifest = {}
  for (const e of events || []) {
    const s = statsById[e.id] || {}
    manifest[e.slug] = {
      id: e.id,
      name: e.name,
      slug: e.slug,
      date: (e.date || '').slice(0, 10),
      location: e.location || null,
      stats: {
        participants: Number(s.participants || 0),
        finishers: Number(s.finishers || 0),
        distances: Array.isArray(s.distances) ? s.distances : [],
        fastest_ms: s.fastest_ms != null ? Number(s.fastest_ms) : null,
        fastest_name: s.fastest_name || null,
      },
    }
  }

  const json = JSON.stringify(manifest, null, 2) + '\n'
  console.log(`Built manifest with ${Object.keys(manifest).length} past public event(s).`)
  for (const k of Object.keys(manifest)) {
    const m = manifest[k]
    console.log(`  ${k}: ${m.stats.participants} zapisanych, ${m.stats.finishers} na mecie, dyst. [${m.stats.distances.join(', ')}]`)
  }

  if (dryRun) {
    console.log(`\n(dry run) Would write ${MANIFEST_PATH}`)
    return
  }
  mkdirSync(EVENTS_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, json)
  console.log(`\nWrote ${MANIFEST_PATH}`)
}

main()
```

- [ ] **Step 2: Run the dry run**

Run:
```bash
cd /Users/derberg/Documents/GitHub/BeepBeep/backend && node --env-file=../.env scripts/publish-leszyrun-events.js
```
Expected: prints `=== DRY RUN ===`, a count line, one line per past public event, and `(dry run) Would write .../public/public/events/.manifest.json`. No file written.

- [ ] **Step 3: Run with `--apply`**

Run:
```bash
cd /Users/derberg/Documents/GitHub/BeepBeep/backend && node --env-file=../.env scripts/publish-leszyrun-events.js --apply
```
Expected: ends with `Wrote .../public/public/events/.manifest.json`.

- [ ] **Step 4: Verify the manifest shape**

Run:
```bash
node --input-type=module -e '
import { readFileSync } from "fs"
import assert from "node:assert"
const m = JSON.parse(readFileSync("/Users/derberg/Documents/GitHub/BeepBeep/public/public/events/.manifest.json","utf-8"))
const keys = Object.keys(m)
assert.ok(keys.length >= 0, "manifest is an object")
for (const k of keys) {
  const e = m[k]
  assert.equal(e.slug, k, "key equals slug")
  assert.ok(e.date && e.date < new Date().toISOString().slice(0,10), "date is in the past")
  assert.ok(e.stats && typeof e.stats.participants === "number", "stats.participants is a number")
  assert.ok(Array.isArray(e.stats.distances), "stats.distances is an array")
}
console.log("OK:", keys.length, "events validated")
'
```
Expected: `OK: <n> events validated`.

- [ ] **Step 5: Commit**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep
git add backend/scripts/publish-leszyrun-events.js public/public/events/.manifest.json
git commit -m "feat: publish script + manifest for past leszy.run events"
```

---

### Task 3: `generate-leszyrun-event-pages.js` — bake static pages + wire into build

**Files:**
- Create: `public/scripts/generate-leszyrun-event-pages.js`
- Modify: `public/package.json` (build script)

**Interfaces:**
- Consumes: `public/public/events/.manifest.json` (Task 2); `dist/index.html` (Vite assets); existing `dist/sitemap.xml` (from `generate-event-pages.js`).
- Produces: `dist/events/<slug>/index.html` per manifest entry, with:
  - `<title>`, `<meta name="description">`, `<meta name="robots" content="index, follow">`, `<link rel="canonical" href="https://www.leszy.run/events/<slug>">`
  - `SportsEvent` JSON-LD with `eventStatus: EventCompleted`
  - an embedded `<script id="event-data" type="application/json">` containing the manifest entry (consumed by `EventHub`, Task 4)
  - a static results link `<a href="/events/<slug>/results">` and a cross-link nav to other past events (crawlable, outside `#root`)
  - appended `<url>` entries in `dist/sitemap.xml`

- [ ] **Step 1: Write the script**

Create `public/scripts/generate-leszyrun-event-pages.js`:

```js
// Post-build script: generates static per-past-event HTML files for leszy.run events
// into dist/events/:slug/ and appends them to dist/sitemap.xml.
// Reads .manifest.json produced by backend/scripts/publish-leszyrun-events.js
// and the Vite-built dist/index.html (for hashed asset tags).
// Runs AFTER generate-event-pages.js (which creates sitemap.xml) and BEFORE/with
// generate-landing-pages.js (both append to the same sitemap).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = resolve(ROOT, 'dist')
const MANIFEST_PATH = resolve(ROOT, 'public/events/.manifest.json')
const BASE_URL = 'https://www.leszy.run'
const TODAY = new Date().toISOString().slice(0, 10)

const POLISH_MONTHS = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'
]

function formatPolishDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return ''
  return `${d.getDate()} ${POLISH_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDuration(ms) {
  if (ms == null) return ''
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function buildDescription(e) {
  const parts = []
  if (e.date) parts.push(formatPolishDate(e.date))
  if (e.location) parts.push(e.location)
  const st = e.stats || {}
  if (st.finishers) parts.push(`${st.finishers} na mecie`)
  if (Array.isArray(st.distances) && st.distances.length) parts.push(st.distances.join(', '))
  return parts.join(' · ')
}

function buildJsonLd(e) {
  const url = `${BASE_URL}/events/${e.slug}`
  const startDate = e.date ? e.date.slice(0, 10) : undefined
  const sportsEvent = {
    '@type': 'SportsEvent',
    name: e.name,
    description: buildDescription(e) || undefined,
    startDate,
    endDate: startDate,
    eventStatus: 'https://schema.org/EventCompleted',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url,
    inLanguage: 'pl-PL',
    location: e.location ? {
      '@type': 'Place',
      name: e.location,
      address: { '@type': 'PostalAddress', addressCountry: 'PL' },
    } : undefined,
    organizer: { '@type': 'Organization', name: 'Leszy.run', url: BASE_URL },
  }
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: 'Wydarzenia', item: `${BASE_URL}/events` },
      { '@type': 'ListItem', position: 3, name: e.name, item: url },
    ],
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [sportsEvent, breadcrumb] }, null, 2)
}

// Static, crawlable summary + results link + cross-links to other past events.
// Lives OUTSIDE #root so it survives in the DOM for crawlers (React owns only #root).
function buildStaticBody(e, manifest) {
  const st = e.stats || {}
  const statLine = [
    st.participants ? `${st.participants} zapisanych` : null,
    st.finishers ? `${st.finishers} na mecie` : null,
    (Array.isArray(st.distances) && st.distances.length) ? st.distances.join(', ') : null,
    st.fastest_ms != null ? `najlepszy czas ${formatDuration(st.fastest_ms)}${st.fastest_name ? ` (${st.fastest_name})` : ''}` : null,
  ].filter(Boolean).map(escapeHtml).join(' · ')

  const others = Object.keys(manifest).filter(s => s !== e.slug)
  const links = others.map(s => {
    const o = manifest[s]
    const label = escapeHtml([o.name, formatPolishDate(o.date)].filter(Boolean).join(' — '))
    return `      <li style="margin:0"><a href="/events/${escapeHtml(s)}" style="color:#B0AEC6;text-decoration:none;display:block;padding:0.25rem 0">${label}</a></li>`
  }).join('\n')

  const crossNav = others.length ? `  <nav aria-label="Inne minione wydarzenia" style="padding:1.25rem 1.5rem;background:#0A0A10;border-top:1px solid #1C1C2A;font-family:'Rajdhani',sans-serif">
    <h2 style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;color:#DDDCEC;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 0.625rem">Inne minione wydarzenia</h2>
    <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0 1rem;font-size:0.8rem">
${links}
    </ul>
  </nav>` : ''

  return `  <noscript>
    <h1>${escapeHtml(e.name)}</h1>
    <p>${escapeHtml(formatPolishDate(e.date))}${e.location ? ` · ${escapeHtml(e.location)}` : ''}</p>
    <p>${statLine}</p>
    <p><a href="/events/${escapeHtml(e.slug)}/results">Zobacz wyniki</a></p>
  </noscript>
${crossNav}`
}

function buildEventHtml(e, cssLinks, jsScripts, manifest) {
  const title = `${escapeHtml(e.name)} — ${escapeHtml(formatPolishDate(e.date))} — Leszy.run`
  const description = escapeHtml(buildDescription(e))
  const canonical = `${BASE_URL}/events/${e.slug}`
  const eventJson = JSON.stringify(e).replace(/<\//g, '<\\/')
  const jsonLd = buildJsonLd(e).replace(/<\//g, '<\\/')

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
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:site_name" content="Leszy.run" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />

    <link rel="icon" type="image/svg+xml" href="/logo-bez-napisu.svg" />
    <link rel="apple-touch-icon" href="/logo-bez-napisu.svg" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">

    <script type="application/ld+json">
    ${jsonLd}
    </script>

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
${buildStaticBody(e, manifest)}
    <script id="event-data" type="application/json">${eventJson}</script>
    ${jsScripts}
  </body>
</html>`
}

function appendToSitemap(slugs, manifest) {
  const sitemapPath = resolve(DIST, 'sitemap.xml')
  if (!existsSync(sitemapPath)) {
    console.error('sitemap.xml not found — run generate-event-pages.js first')
    process.exit(1)
  }
  let sitemap = readFileSync(sitemapPath, 'utf-8')
  sitemap = sitemap.replace('</urlset>', '')
  const entries = slugs.map(slug => {
    const lastmod = (manifest[slug].date || TODAY).slice(0, 10)
    return `  <url>\n    <loc>${BASE_URL}/events/${slug}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.5</priority>\n  </url>`
  })
  sitemap += entries.join('\n') + (entries.length ? '\n' : '') + '</urlset>\n'
  writeFileSync(sitemapPath, sitemap)
  return entries.length
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`Manifest not found at ${MANIFEST_PATH} — skipping leszy.run event page generation.`)
    return
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  } catch (err) {
    console.error(`Could not parse manifest: ${err.message}`)
    process.exit(1)
  }
  const slugs = Object.keys(manifest)
  console.log(`Found ${slugs.length} past leszy.run event(s) in manifest.`)
  if (slugs.length === 0) return

  const indexPath = resolve(DIST, 'index.html')
  if (!existsSync(indexPath)) {
    console.error(`dist/index.html not found at ${indexPath} — did vite build run?`)
    process.exit(1)
  }
  const indexHtml = readFileSync(indexPath, 'utf-8')
  const cssLinks = (indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('\n    ')
  const jsScripts = (indexHtml.match(/<script\b[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/g) || []).join('\n    ')

  let generated = 0
  for (const slug of slugs) {
    const dir = resolve(DIST, 'events', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'index.html'), buildEventHtml(manifest[slug], cssLinks, jsScripts, manifest))
    generated++
  }
  console.log(`Generated ${generated} past-event HTML file(s).`)

  const added = appendToSitemap(slugs, manifest)
  console.log(`Appended ${added} past-event URL(s) to sitemap.xml.`)
}

main()
```

- [ ] **Step 2: Wire the script into the build**

In `public/package.json`, change the `build` script so the new generator runs after `generate-event-pages.js` and before `generate-landing-pages.js`:

```json
    "build": "node scripts/generate-og-image.js && vite build && node scripts/generate-event-pages.js && node scripts/generate-leszyrun-event-pages.js && node scripts/generate-landing-pages.js",
```

- [ ] **Step 3: Build**

Run:
```bash
cd /Users/derberg/Documents/GitHub/BeepBeep/public && npm run build
```
Expected: build completes; logs include `Found N past leszy.run event(s) in manifest.`, `Generated N past-event HTML file(s).`, and `Appended N past-event URL(s) to sitemap.xml.`

- [ ] **Step 4: Verify generated HTML**

Pick one slug from the manifest and run (replace `<SLUG>`):
```bash
node --input-type=module -e '
import { readFileSync } from "fs"
import assert from "node:assert"
const slug = "<SLUG>"
const html = readFileSync(`/Users/derberg/Documents/GitHub/BeepBeep/public/dist/events/${slug}/index.html`,"utf-8")
assert.ok(html.includes("index, follow"), "robots index,follow")
assert.ok(html.includes(`rel="canonical" href="https://www.leszy.run/events/${slug}"`), "canonical")
assert.ok(html.includes("EventCompleted"), "JSON-LD EventCompleted")
assert.ok(html.includes(`/events/${slug}/results`), "results link present")
assert.ok(html.includes(`id="event-data"`), "embedded event-data")
console.log("OK: HTML for", slug, "valid")
'
```
Expected: `OK: HTML for <SLUG> valid`.

- [ ] **Step 5: Verify sitemap contains the past events**

Run (replace `<SLUG>`):
```bash
grep -c "/events/<SLUG></loc>" /Users/derberg/Documents/GitHub/BeepBeep/public/dist/sitemap.xml
```
Expected: `1`.

- [ ] **Step 6: Commit**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep
git add public/scripts/generate-leszyrun-event-pages.js public/package.json
git commit -m "feat: bake static past-event pages into the public build"
```

---

### Task 4: EventHub — render past-event stats from embedded JSON

**Files:**
- Modify: `public/src/pages/EventHub.jsx`

**Interfaces:**
- Consumes: the embedded `<script id="event-data">` JSON baked in Task 3 (shape = manifest entry, incl. `.stats`). Falls back to `useEvent()` (live `events` query) when no embedded data is present (upcoming events / SPA navigation).
- Produces: visual stats card + "Zobacz wyniki →" CTA for past events; unchanged "Wyniki na żywo" flow for upcoming events.

- [ ] **Step 1: Replace EventHub.jsx**

Overwrite `public/src/pages/EventHub.jsx`:

```jsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useEvent } from '../hooks/useEvent.js'
import useSeo from '../hooks/useSeo.js'

// Read the static page's embedded stats (baked by generate-leszyrun-event-pages.js).
// Returns the manifest entry ({ ...event, stats }) or null on a plain SPA hit.
function readEmbeddedEvent() {
  if (typeof document === 'undefined') return null
  const el = document.getElementById('event-data')
  if (!el) return null
  try {
    const data = JSON.parse(el.textContent)
    return data && data.stats ? data : null
  } catch {
    return null
  }
}

function formatDuration(ms) {
  if (ms == null) return ''
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function Stat({ value, label }) {
  return (
    <div className="flex flex-col items-center border border-apex-border bg-apex-surface px-4 py-5">
      <span className="font-mono text-3xl md:text-4xl font-bold text-apex-yellow">{value}</span>
      <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted mt-1">{label}</span>
    </div>
  )
}

function PastEventView({ event }) {
  const st = event.stats || {}
  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright page-watermark">
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Minione wydarzenie</p>
        <h1 className="font-display text-5xl uppercase tracking-widest mb-2">{event.name}</h1>
        {event.date && <p className="text-apex-muted text-sm mb-10">{event.date}{event.location ? ` · ${event.location}` : ''}</p>}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-0.5 mb-4">
          <Stat value={st.participants ?? 0} label="Zapisanych" />
          <Stat value={st.finishers ?? 0} label="Na mecie" />
          <Stat value={Array.isArray(st.distances) ? st.distances.length : 0} label="Kategorii" />
          <Stat value={st.fastest_ms != null ? formatDuration(st.fastest_ms) : '—'} label="Najlepszy czas" />
        </div>

        {Array.isArray(st.distances) && st.distances.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-center mb-3">
            {st.distances.map(d => (
              <span key={d} className="font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border border-apex-yellow/30 text-apex-yellow-dim uppercase">{d}</span>
            ))}
          </div>
        )}
        {st.fastest_name && st.fastest_ms != null && (
          <p className="text-apex-muted text-xs mb-10">Najszybszy zawodnik: <span className="text-apex-text-bright">{st.fastest_name}</span></p>
        )}

        <Link to={`/events/${event.slug}/results`} className="inline-block border-2 border-apex-yellow bg-apex-yellow text-apex-ink px-10 py-4 font-display font-bold uppercase tracking-widest hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
          Zobacz wyniki →
        </Link>
      </div>
    </div>
  )
}

function UpcomingEventView({ event }) {
  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright page-watermark">
      <div className="max-w-lg mx-auto px-6 py-16 text-center">
        <h1 className="font-display text-5xl uppercase tracking-widest mb-2">{event.name}</h1>
        {event.date && <p className="text-apex-muted text-sm mb-12">{event.date}{event.location ? ` · ${event.location}` : ''}</p>}
        <div className="space-y-3">
          <Link to={`/events/${event.slug}/results`} className="block border border-apex-border bg-apex-surface px-6 py-4 hover:bg-apex-surface-2 transition-colors text-apex-text-bright font-semibold uppercase tracking-wider">
            Wyniki na zywo
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function EventHub() {
  const [embedded] = useState(() => readEmbeddedEvent())
  const { event: liveEvent, loading, error } = useEvent()

  // Past event with baked stats → render from embedded data (no live query needed).
  const event = embedded || liveEvent
  const isPast = !!(embedded && embedded.stats) ||
    (!!event && !!event.date && event.date.slice(0, 10) < new Date().toISOString().slice(0, 10) && !!event.stats)

  useSeo({
    title: event?.name || 'Wydarzenie',
    description: event ? `${event.name}${event.location ? ` — ${event.location}` : ''}${event.date ? ` — ${event.date}` : ''}.${isPast ? ' Wyniki i statystyki wydarzenia.' : ' Wyniki na żywo, lista startowa i informacje o wydarzeniu.'}` : undefined,
    jsonLd: event ? {
      '@context': 'https://schema.org',
      '@type': 'SportsEvent',
      name: event.name,
      startDate: event.date,
      location: event.location ? { '@type': 'Place', name: event.location, address: { '@type': 'PostalAddress', addressCountry: 'PL' } } : undefined,
      url: `https://www.leszy.run/events/${event.slug}`,
      organizer: { '@id': 'https://www.leszy.run/#organization' },
      eventStatus: isPast ? 'https://schema.org/EventCompleted' : 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    } : undefined,
  })

  if (embedded) return <PastEventView event={embedded} />
  if (loading) return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ładowanie...</div>
  if (error) return <div className="flex items-center justify-center min-h-screen text-apex-red">{error}</div>
  return <UpcomingEventView event={event} />
}
```

- [ ] **Step 2: Verify the build still compiles**

Run:
```bash
cd /Users/derberg/Documents/GitHub/BeepBeep/public && npm run build
```
Expected: build succeeds with no errors; past-event pages still generated.

- [ ] **Step 3: Visual check — past event**

Run `cd /Users/derberg/Documents/GitHub/BeepBeep/public && npm run preview`, then open `http://localhost:4173/events/<SLUG>` for a past event slug from the manifest.
Expected: "Minione wydarzenie" header, the 4 stat tiles (Zapisanych / Na mecie / Kategorii / Najlepszy czas), distance chips, and a yellow "Zobacz wyniki →" button linking to `/events/<SLUG>/results`. Stop the preview server when done.

- [ ] **Step 4: Visual check — upcoming event regression**

In the same preview, open `http://localhost:4173/events/<UPCOMING_SLUG>` for a public upcoming event (no embedded stats → live query path).
Expected: the original simple hub with the "Wyniki na zywo" button. No crash.

- [ ] **Step 5: Commit**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep
git add public/src/pages/EventHub.jsx
git commit -m "feat: past-event stats view on EventHub"
```

---

### Task 5: Landing page — "Minione wydarzenia" strip

**Files:**
- Modify: `public/src/pages/Landing.jsx`

**Interfaces:**
- Consumes: `events` table via the existing `supabase` client (`visibility='public'`, `date < today`).
- Produces: a `PastEventsStrip` section rendered between `EventsSection` and the following divider; renders nothing when there are no past events.

- [ ] **Step 1: Add the PastEventsStrip component**

In `public/src/pages/Landing.jsx`, add this component immediately after the `EventsSection` function (after its closing `}` near line 214):

```jsx
function PastEventsStrip() {
  const [events, setEvents] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    supabase
      .from('events')
      .select('id, name, date, slug')
      .eq('visibility', 'public')
      .lt('date', today)
      .order('date', { ascending: false })
      .then(({ data, error }) => {
        if (error) console.error('Past events fetch error:', error.message)
        setEvents(data || [])
        setLoaded(true)
      })
  }, [])

  if (!loaded || events.length === 0) return null

  return (
    <section aria-label="Minione wydarzenia" className="py-10 md:py-12 px-6 max-w-[1100px] mx-auto">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-4">Minione wydarzenia</p>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {events.map(ev => (
          <Link
            key={ev.id}
            to={`/events/${ev.slug}`}
            className="flex-shrink-0 flex flex-col gap-1 bg-apex-surface border border-apex-border px-4 py-3 no-underline text-inherit hover:border-apex-yellow-dim hover:bg-apex-surface-2 transition-all"
          >
            <span className="font-mono text-[11px] text-apex-yellow-dim">
              {new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
            </span>
            <span className="font-display font-bold text-sm tracking-wide uppercase text-apex-text-bright whitespace-nowrap">{ev.name}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Render the strip in the page**

In the `Landing` component's JSX, insert the strip and a divider right after the `<EventsSection />` line:

```jsx
        <EventsSection />
        <div className="w-full h-px bg-apex-border" />
        <PastEventsStrip />
        <div className="w-full h-px bg-apex-border" />
        <KalendarzTeaser />
```

(The existing divider after `EventsSection` stays; you are adding `<PastEventsStrip />` and one more divider before `KalendarzTeaser`. If there are no past events the strip renders `null`, leaving two adjacent dividers — acceptable, but to avoid a double rule you may instead place `<PastEventsStrip />` between the existing divider and `KalendarzTeaser` without adding a second divider. Use the no-extra-divider form:)

```jsx
        <EventsSection />
        <div className="w-full h-px bg-apex-border" />
        <PastEventsStrip />
        <KalendarzTeaser />
```

Use the second (no-extra-divider) form.

- [ ] **Step 3: Build**

Run:
```bash
cd /Users/derberg/Documents/GitHub/BeepBeep/public && npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Visual check**

Run `npm run preview`, open `http://localhost:4173/`, scroll to below "Najbliższe biegi".
Expected: a "Minione wydarzenia" strip of horizontally-scrollable chips (date + name), each linking to `/events/<slug>`. If there are no past public events, the strip is absent (no empty header). Click a chip → lands on the past-event page from Task 4. Stop preview when done.

- [ ] **Step 5: Commit**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep
git add public/src/pages/Landing.jsx
git commit -m "feat: past events strip on landing page"
```

---

### Task 6: Documentation — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing. Produces: docs for the new view + scripts so future sessions know the refresh workflow.

- [ ] **Step 1: Document the Supabase-only view**

In `CLAUDE.md`, in the "**Supabase-only tables**" bullet list (under the "Supabase project" section), add:

```markdown
- `event_results_summary` — read-only view aggregating per-event stats (participants, finishers, timed distances, fastest finisher) for past-event public pages. Created via `apply_migration` only.
```

- [ ] **Step 2: Document the publish + generate scripts**

In `CLAUDE.md`, under the "Public app — Landing page & Kalendarz" → "Static HTML generation (SEO)" section, add a bullet after the existing two generator bullets:

```markdown
- `scripts/generate-leszyrun-event-pages.js` — one file per past, public leszy.run event at `/events/:slug` (reads `public/public/events/.manifest.json`), with baked stats + a "Zobacz wyniki" link to the internal results. The manifest is produced by `backend/scripts/publish-leszyrun-events.js --apply` (host: `cd backend && node --env-file=../.env scripts/publish-leszyrun-events.js --apply`). Re-run after a new event finishes, then commit the refreshed manifest.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/derberg/Documents/GitHub/BeepBeep
git add CLAUDE.md
git commit -m "docs: document past-event view and publish/generate scripts"
```

---

## Self-Review

**Spec coverage:**
- Supabase view `event_results_summary` → Task 1 ✓
- Publish script writes committed manifest (one Supabase read) → Task 2 ✓
- Generate script bakes static HTML per past public event → Task 3 ✓
- Build wiring → Task 3 Step 2 ✓
- EventHub past-event stats + internal results CTA, upcoming unchanged → Task 4 ✓
- Landing compact strip, live query, renders nothing when empty → Task 5 ✓
- SEO: `index, follow` + sitemap + crawlable static links → Task 3 (robots, sitemap append, static cross-link nav + `<noscript>` results link) ✓
- Edge cases: zero finishers (stats show 0, fastest `—`), untimed-only (`distances` empty → chips hidden), missing manifest (generate skips; SPA still resolves) → handled in Tasks 3/4 ✓
- Stats shown: participants/finishers, distances/categories, date/location, fastest → Tasks 1/4 ✓
- Docs → Task 6 ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; `<SLUG>`/`<UPCOMING_SLUG>` are explicit user-substituted runtime values in verification commands, not code placeholders.

**Type/name consistency:**
- Manifest entry shape (`{id,name,slug,date,location,stats:{participants,finishers,distances,fastest_ms,fastest_name}}`) is identical across Task 2 (writer), Task 3 (`buildEventHtml`/`buildStaticBody`), and Task 4 (`readEmbeddedEvent`/`PastEventView`).
- View columns (`event_id, participants, finishers, distances, fastest_ms, fastest_name`) match the `.select()` in Task 2.
- `formatDuration(ms)` defined identically in Task 3 and Task 4 (intentional small duplication across the Node script and the React app, which share no module).
- Embedded element id `event-data` matches the existing `EventPage.jsx` convention and Task 4's reader.

**SEO crawlability note (honest limitation):** the landing strip is React-rendered, so its links are JS-dependent. Crawl discovery for the past-event pages therefore relies on (a) the sitemap entries and (b) the static cross-link nav baked onto each past-event page (an interlinked mesh). This is sufficient for the current small set; if the past-event count grows large, consider a dedicated static archive page with server-rendered links.
