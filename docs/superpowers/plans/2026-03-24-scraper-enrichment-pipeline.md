# Scraper Enrichment Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scraper pipeline find official event websites via Brave search, then use Claude to extract all missing event data from those pages.

**Architecture:** Source scrapers discover events and collect basic data. URL resolver finds official websites via Brave and auto-assigns them. LLM enricher visits those websites with Playwright, extracts page text, and sends it to Claude Haiku to fill missing fields (distances, event_type, voivodeship, prices, organizer, deadline). An `enriched_at` timestamp prevents reprocessing on subsequent runs.

**Tech Stack:** Playwright, Claude CLI (haiku), Brave Search API, Supabase JS client

**Spec:** `docs/superpowers/specs/2026-03-24-scraper-enrichment-pipeline-design.md`

---

### Task 1: Add `enriched_at` column to Supabase

**Files:**
- None (Supabase-only migration via MCP tool)

- [ ] **Step 1: Apply migration**

Run via `mcp__supabase__apply_migration`:
```sql
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
```

- [ ] **Step 2: Verify column exists**

Run via `mcp__supabase__execute_sql`:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'calendar_events' AND column_name = 'enriched_at';
```
Expected: 1 row with `enriched_at`, `timestamp with time zone`

- [ ] **Step 3: Commit**

Nothing to commit (Supabase-only change).

---

### Task 2: Remove `registration_url` from source scrapers

**Files:**
- Modify: `backend/src/scrapers/sources/maratonypolskie.js:68`
- Modify: `backend/src/scrapers/sources/datasport.js:100`
- Modify: `backend/src/scrapers/sources/biegiwpolsce.js:155`
- No change: `backend/src/scrapers/sources/elektronicznezapisy.js` (keeps signup link)

- [ ] **Step 1: Update maratonypolskie.js**

Change line 68 from:
```js
registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
```
to:
```js
registration_url: null,
```

The `href` is still used on line 145 to visit detail pages during scraping — that logic stays. Only the output field changes.

- [ ] **Step 2: Update datasport.js**

Change line 100 from:
```js
registration_url: entry.href,
```
to:
```js
registration_url: null,
```

- [ ] **Step 3: Update biegiwpolsce.js**

Change line 155 from:
```js
registration_url: entry.href ? (entry.href.startsWith('http') ? entry.href : `${BASE_URL}${entry.href}`) : null,
```
to:
```js
registration_url: null,
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/scrapers/sources/maratonypolskie.js backend/src/scrapers/sources/datasport.js backend/src/scrapers/sources/biegiwpolsce.js
git commit -m "fix: stop setting registration_url to aggregator site links

Source scrapers now leave registration_url as null. The URL resolver
will fill it with the official event website found via Brave search.
elektronicznezapisy.pl keeps its signup links (actual registration portal)."
```

---

### Task 3: Rewrite URL resolver — auto-assign top Brave result

**Files:**
- Modify: `backend/src/scrapers/urlResolver.js` (full rewrite)

- [ ] **Step 1: Rewrite urlResolver.js**

```js
import { supabase } from '../lib/supabaseClient.js'

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'

const AGGREGATOR_DOMAINS = [
  'maratonypolskie.pl',
  'liveds.datasport.pl',
  'datasport.pl',
  'biegiwpolsce.pl',
  'elektronicznezapisy.pl',
  'bieganie.pl',
  'kalendarzbiegowy.pl',
]

function isAggregatorUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return AGGREGATOR_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

async function searchBrave(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) return []

  try {
    const params = new URLSearchParams({ q: query, count: '5' })
    const res = await fetch(`${BRAVE_API_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    })

    const data = await res.json()
    return (data.web?.results || []).map((r, i) => ({
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
  if (!process.env.BRAVE_SEARCH_API_KEY || !supabase) {
    console.log('[urlResolver] BRAVE_SEARCH_API_KEY not set or Supabase not configured, skipping')
    return { processed: 0, assigned: 0 }
  }

  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, date, location')
    .is('registration_url', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(50)

  if (!events?.length) {
    console.log('[urlResolver] No events need URL resolution')
    return { processed: 0, assigned: 0 }
  }

  let assigned = 0

  for (const event of events) {
    const year = new Date(event.date).getFullYear()
    const query = `${event.name} ${year} zapisy rejestracja ${event.location || ''}`
    const results = await searchBrave(query)

    // Filter out aggregator domains
    const filtered = results.filter(r => !isAggregatorUrl(r.url))
    const bestUrl = filtered.length > 0 ? filtered[0].url : null

    // Save all results as audit trail
    if (results.length > 0) {
      const suggestions = results.map(r => ({
        calendar_event_id: event.id,
        search_query: query,
        search_engine: 'brave',
        rank: r.rank,
        url: r.url,
        page_title: r.page_title,
        snippet: r.snippet,
        status: (bestUrl && r.url === bestUrl) ? 'auto_assigned' : 'alternative',
      }))

      await supabase.from('url_suggestions').insert(suggestions)
    }

    // Auto-assign best non-aggregator URL
    if (bestUrl) {
      const { error } = await supabase
        .from('calendar_events')
        .update({ registration_url: bestUrl })
        .eq('id', event.id)

      if (!error) {
        console.log(`[urlResolver] ${event.name} → ${bestUrl}`)
        assigned++
      }
    }

    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[urlResolver] Processed ${events.length} events, assigned ${assigned} URLs`)
  return { processed: events.length, assigned }
}

export { resolveUrls }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/urlResolver.js
git commit -m "feat: auto-assign official event URLs from Brave search results

URL resolver now auto-assigns the top non-aggregator Brave result as
registration_url instead of saving pending suggestions for admin review.
Filters out known aggregator domains. All results saved as audit trail."
```

---

### Task 4: Rewrite LLM enricher — Playwright + Claude for all missing fields

**Files:**
- Modify: `backend/src/scrapers/llmEnricher.js` (full rewrite)

- [ ] **Step 1: Rewrite llmEnricher.js**

```js
import { supabase } from '../lib/supabaseClient.js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chromium } from 'playwright'

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const VALID_EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic', 'ultra', 'charytatywny', 'uliczny']

function checkClaudeCli() {
  try {
    execSync('claude --version', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function buildPrompt(event, pageText) {
  return `You are extracting structured data about a Polish running/walking race event from its official website.

Event name: ${event.name}
Event date: ${event.date}
Event location: ${event.location || 'unknown'}

Website content:
${pageText}

Extract the following information. Return ONLY valid JSON, no other text.
{
  "distances_km": [numbers, e.g. 5, 10, 21.1, 42.2] or null,
  "event_type": [array from: "trail", "nocny", "ocr", "nordic", "ultra", "charytatywny", "uliczny"] or null,
  "voivodeship": "one of 16 Polish voivodeships" or null,
  "price_from_pln": number (lowest entry fee in PLN) or null,
  "price_to_pln": number (highest entry fee in PLN) or null,
  "organizer": "organizer name" or null,
  "registration_deadline": "YYYY-MM-DD" or null,
  "description": "1-2 sentence summary of the event in Polish" or null
}

Rules:
- Only include distances that are actual race distances, not age limits or other numbers
- For półmaraton include 21.1, for maraton include 42.2
- Prices should be in PLN (złotych), not grosze
- If information is not found on the page, use null
- voivodeship must be one of: ${VOIVODESHIPS.join(', ')}`
}

function callClaude(prompt) {
  const tmpFile = join(tmpdir(), `llm-enrich-${Date.now()}.txt`)

  try {
    writeFileSync(tmpFile, prompt, 'utf-8')
    const result = execSync(
      `cat "${tmpFile}" | claude -p --model haiku --output-format text`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 }
    )

    const match = result.match(/\{[\s\S]*\}/)
    if (match) {
      return JSON.parse(match[0])
    }
  } catch (err) {
    console.error(`[enricher] Claude call failed:`, err.message?.slice(0, 100))
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
  return null
}

function validateAndMerge(event, extracted) {
  const updates = {}

  // Distances
  if (extracted.distances_km && Array.isArray(extracted.distances_km) && extracted.distances_km.length > 0) {
    const valid = extracted.distances_km.filter(d => typeof d === 'number' && d > 0 && d < 500)
    if (valid.length > 0 && (!event.distances_meters || event.distances_meters.length === 0)) {
      updates.distances = valid.map(d => `${d} km`)
      updates.distances_meters = valid.map(d => Math.round(d * 1000))
    }
  }

  // Event type
  if (extracted.event_type && Array.isArray(extracted.event_type)) {
    const valid = extracted.event_type.filter(t => VALID_EVENT_TYPES.includes(t))
    if (valid.length > 0 && (!event.event_type || event.event_type.length === 0)) {
      updates.event_type = valid
    }
  }

  // Voivodeship
  if (extracted.voivodeship && VOIVODESHIPS.includes(extracted.voivodeship)) {
    if (!event.voivodeship) {
      updates.voivodeship = extracted.voivodeship
    }
  }

  // Prices (convert PLN to grosze)
  if (typeof extracted.price_from_pln === 'number' && extracted.price_from_pln > 0) {
    if (!event.price_from) {
      updates.price_from = Math.round(extracted.price_from_pln * 100)
    }
  }
  if (typeof extracted.price_to_pln === 'number' && extracted.price_to_pln > 0) {
    if (!event.price_to) {
      updates.price_to = Math.round(extracted.price_to_pln * 100)
    }
  }

  // Organizer
  if (extracted.organizer && typeof extracted.organizer === 'string') {
    if (!event.organizer) {
      updates.organizer = extracted.organizer.slice(0, 200)
    }
  }

  // Registration deadline
  if (extracted.registration_deadline && /^\d{4}-\d{2}-\d{2}$/.test(extracted.registration_deadline)) {
    if (!event.registration_deadline) {
      updates.registration_deadline = extracted.registration_deadline
    }
  }

  // Description (only when NULL)
  if (extracted.description && typeof extracted.description === 'string') {
    if (!event.description) {
      updates.description = extracted.description.slice(0, 2000)
    }
  }

  return updates
}

async function fetchPageText(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
  } catch {
    // Fallback to domcontentloaded on timeout
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
    } catch (err) {
      console.error(`[enricher] Failed to load ${url}:`, err.message?.slice(0, 80))
      return null
    }
  }

  try {
    const text = await page.evaluate(() => document.body.innerText)
    return text?.replace(/\s+/g, ' ').trim().slice(0, 5000) || null
  } catch {
    return null
  }
}

async function enrichEvents() {
  if (!supabase) {
    console.log('[enricher] Supabase not configured, skipping')
    return { processed: 0, enriched: 0 }
  }

  // Preflight: check Claude CLI
  if (!checkClaudeCli()) {
    console.log('[enricher] Claude CLI not available, skipping enrichment')
    return { processed: 0, enriched: 0 }
  }

  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, date, location, registration_url, distances, distances_meters, event_type, voivodeship, price_from, price_to, organizer, registration_deadline, description')
    .is('enriched_at', null)
    .not('registration_url', 'is', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(parseInt(process.env.LLM_BATCH_SIZE || '50', 10))

  if (!events?.length) {
    console.log('[enricher] No events need enrichment')
    return { processed: 0, enriched: 0 }
  }

  console.log(`[enricher] Processing ${events.length} events...`)
  let enriched = 0
  let browser

  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)

    for (const event of events) {
      console.log(`[enricher] ${event.name} → ${event.registration_url}`)

      // Fetch page content
      const pageText = await fetchPageText(page, event.registration_url)

      if (!pageText || pageText.length < 50) {
        console.log(`[enricher]   Skipped (no content)`)
        // Still mark as enriched to avoid retrying pages that don't load
        await supabase
          .from('calendar_events')
          .update({ enriched_at: new Date().toISOString() })
          .eq('id', event.id)
        continue
      }

      // Call Claude
      const prompt = buildPrompt(event, pageText)
      const extracted = callClaude(prompt)

      if (extracted) {
        const updates = validateAndMerge(event, extracted)
        const fieldCount = Object.keys(updates).length

        if (fieldCount > 0) {
          updates.enriched_at = new Date().toISOString()
          const { error } = await supabase
            .from('calendar_events')
            .update(updates)
            .eq('id', event.id)

          if (!error) {
            console.log(`[enricher]   Enriched ${fieldCount} fields: ${Object.keys(updates).filter(k => k !== 'enriched_at').join(', ')}`)
            enriched++
          } else {
            console.error(`[enricher]   Update failed:`, error.message)
          }
        } else {
          // No new fields but mark as enriched
          await supabase
            .from('calendar_events')
            .update({ enriched_at: new Date().toISOString() })
            .eq('id', event.id)
          console.log(`[enricher]   No new fields to fill`)
        }
      } else {
        // Claude returned nothing — still mark enriched
        await supabase
          .from('calendar_events')
          .update({ enriched_at: new Date().toISOString() })
          .eq('id', event.id)
        console.log(`[enricher]   Claude returned no data`)
      }

      // Delay between Claude CLI calls
      await new Promise(r => setTimeout(r, 2000))
    }
  } catch (err) {
    console.error('[enricher] Browser error:', err.message)
  } finally {
    if (browser) await browser.close()
  }

  console.log(`[enricher] Enriched ${enriched}/${events.length} events`)
  return { processed: events.length, enriched }
}

export { enrichEvents }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/llmEnricher.js
git commit -m "feat: rewrite LLM enricher to visit official websites and extract all fields

Enricher now uses Playwright to visit registration_url, extracts page
text, and sends it to Claude Haiku to fill all missing fields: distances,
event_type, voivodeship, prices, organizer, registration_deadline,
description. Includes enriched_at timestamp to skip on subsequent runs,
Claude CLI preflight check, and networkidle wait for SPA sites."
```

---

### Task 5: Update orchestrator import

**Files:**
- Modify: `backend/src/scrapers/index.js:8,57`

- [ ] **Step 1: Update import and call**

Change line 8 from:
```js
import { enrichDistances } from './llmEnricher.js'
```
to:
```js
import { enrichEvents } from './llmEnricher.js'
```

Change line 57 from:
```js
results.llmEnricher = await enrichDistances()
```
to:
```js
results.llmEnricher = await enrichEvents()
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/scrapers/index.js
git commit -m "fix: update orchestrator to use renamed enrichEvents export"
```

---

### Task 6: Clean up stale aggregator URLs + delete old data + run pipeline

**Files:**
- None (Supabase SQL + HTTP trigger)

- [ ] **Step 1: Delete all calendar_events from Supabase**

Run via `mcp__supabase__execute_sql`:
```sql
DELETE FROM calendar_events;
```

- [ ] **Step 2: Delete old url_suggestions**

Run via `mcp__supabase__execute_sql`:
```sql
DELETE FROM url_suggestions;
```

- [ ] **Step 3: Start backend and trigger scraper**

```bash
# Ensure backend is running (docker compose up)
# Then trigger:
curl -X POST http://localhost:3001/api/scrapers/run
```

- [ ] **Step 4: Verify results**

Run via `mcp__supabase__execute_sql`:
```sql
-- Check total events
SELECT count(*) FROM calendar_events;

-- Check URL assignment
SELECT count(*) FROM calendar_events WHERE registration_url IS NOT NULL;
SELECT count(*) FROM calendar_events WHERE registration_url LIKE '%maratonypolskie%' OR registration_url LIKE '%datasport%' OR registration_url LIKE '%biegiwpolsce%';

-- Check enrichment
SELECT count(*) FROM calendar_events WHERE enriched_at IS NOT NULL;

-- Sample enriched event
SELECT name, registration_url, event_type, voivodeship, distances, price_from, price_to, organizer, enriched_at
FROM calendar_events WHERE enriched_at IS NOT NULL LIMIT 3;
```

Expected:
- Total events > 500
- Most events have `registration_url` (not aggregator domains)
- Zero aggregator URLs in `registration_url`
- `enriched_at` set on processed events
- Enriched events have `event_type`, `voivodeship`, etc. filled in
