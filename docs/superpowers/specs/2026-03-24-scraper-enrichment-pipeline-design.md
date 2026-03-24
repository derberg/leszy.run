# Scraper Enrichment Pipeline — Design Spec

**Date:** 2026-03-24
**Status:** Approved

## Problem

The scraper pipeline discovers events from 4 Polish running-event aggregator sites but:
- Sets `registration_url` to source site links (maratonypolskie.pl, datasport.pl) instead of official event pages
- URL resolver only saves Brave search results as pending suggestions for admin review — never auto-assigns
- LLM enricher only extracts distances — ignores event type, voivodeship, prices, organizer, deadline
- LLM enricher never visits the found official website — only works with already-scraped description text
- No mechanism to skip already-enriched events on subsequent runs

## Revised Pipeline Flow

```
Source scrapers (4x)
  → basic data: name, date, location, distances if visible
  → registration_url = NULL (source links stay in source_url only)
      ↓
Normalize + dedup + upsert to Supabase
      ↓
URL Resolver (events where registration_url IS NULL)
  → Brave search: "{name} {year} zapisy {location}"
  → Auto-assign top result as registration_url
  → Save all 3 results to url_suggestions as audit trail
      ↓
LLM Enricher (events where enriched_at IS NULL)
  → Launch Playwright, reuse one browser instance for the batch
  → Visit registration_url → extract document.body.innerText (limit ~5000 chars)
  → Call Claude Haiku with event name + page content
  → Extract all missing fields (see below)
  → Update Supabase, set enriched_at = now()
```

## Incremental Run Logic

| Step | Triggers processing | Skip condition |
|------|---------------------|----------------|
| Scrapers | Always run (discover new events) | — |
| Upsert | Always (dedup prevents duplicates) | Matched by source+source_id or name similarity+date |
| URL resolver | `registration_url IS NULL` | Already has URL |
| LLM enricher | `enriched_at IS NULL` | Already enriched |

On a repeat run (e.g., one week later), only newly discovered events go through URL resolution and LLM enrichment. Existing events are upserted (metadata refreshed from source) but skip the expensive steps.

To force re-enrichment, reset `enriched_at = NULL` on target events.

## Schema Change

Add column to `calendar_events` in Supabase (Supabase-only table, no local Drizzle migration):

```sql
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
```

## Source Scraper Changes

All 4 source scrapers stop setting `registration_url` to the source site's event page. The source link stays in `source_url` (already set). `registration_url` is left `NULL` for the URL resolver to fill with the official event website.

**Files:**
- `backend/src/scrapers/sources/maratonypolskie.js` — set `registration_url: null`
- `backend/src/scrapers/sources/datasport.js` — set `registration_url: null`
- `backend/src/scrapers/sources/elektronicznezapisy.js` — set `registration_url: null`
- `backend/src/scrapers/sources/biegiwpolsce.js` — set `registration_url: null`

## URL Resolver Changes

**File:** `backend/src/scrapers/urlResolver.js`

Current behavior: searches Brave, saves top 3 results to `url_suggestions` with `status: 'pending'` for admin review.

New behavior:
1. Search Brave with query: `"{name} {year} zapisy rejestracja {location}"`
2. Auto-assign **top result URL** as `registration_url` on the `calendar_events` row
3. Still save all 3 results to `url_suggestions` as audit trail (status can be `'auto_assigned'` for rank 1, `'alternative'` for rank 2-3)
4. Rate limit: 1.1s between Brave API calls (preserve existing behavior)
5. Batch limit: 50 events per run (preserve existing behavior)

## LLM Enricher Rewrite

**File:** `backend/src/scrapers/llmEnricher.js`

### Fields to extract

The enricher fills any of these fields when missing on the event:

| Field | Type | Example |
|-------|------|---------|
| `distances` | TEXT[] | `["5 km", "10 km", "21.1 km"]` |
| `distances_meters` | INT[] | `[5000, 10000, 21100]` |
| `event_type` | TEXT[] | `["trail", "nocny"]` |
| `voivodeship` | TEXT | `"Małopolskie"` |
| `price_from` | INT (grosze) | `5000` (= 50 PLN) |
| `price_to` | INT (grosze) | `12000` (= 120 PLN) |
| `organizer` | TEXT | `"Fundacja Biegowa"` |
| `registration_deadline` | DATE | `"2026-05-01"` |
| `description` | TEXT | Clean 1-2 sentence summary |

### Process

1. Query Supabase for events where `enriched_at IS NULL`, `status = 'active'`, `date >= today`, `registration_url IS NOT NULL`. Batch limit: 50 (configurable via `LLM_BATCH_SIZE` env var).
2. Launch Playwright (headless Chromium), reuse one browser instance for the entire batch.
3. For each event:
   a. Navigate to `registration_url`, wait for DOM content loaded, timeout 10s.
   b. Extract `document.body.innerText`, truncate to 5000 chars.
   c. Build prompt with event name + page content + list of missing fields.
   d. Call `claude -p --model haiku` to extract structured JSON.
   e. Parse response, validate types.
   f. Update Supabase: only overwrite fields that are currently NULL/empty on the event.
   g. Set `enriched_at = now()` regardless of whether Claude found anything (prevents re-processing).
   h. 2s delay between Claude CLI calls.
4. Close browser.

### Claude Prompt

```
You are extracting structured data about a Polish running/walking race event from its official website.

Event name: {name}
Event date: {date}
Event location: {location}

Website content:
{page_text}

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
- voivodeship must be one of: Dolnośląskie, Kujawsko-Pomorskie, Łódzkie, Lubelskie, Lubuskie, Małopolskie, Mazowieckie, Opolskie, Podkarpackie, Podlaskie, Pomorskie, Śląskie, Świętokrzyskie, Warmińsko-Mazurskie, Wielkopolskie, Zachodniopomorskie
```

### Merge logic

Only non-null fields from Claude's response overwrite existing data. Never blank out something already known from the scraper. Prices are converted from PLN to grosze before storing (`price * 100`).

## Files Changed Summary

| File | Change |
|------|--------|
| `sources/maratonypolskie.js` | `registration_url: null` |
| `sources/datasport.js` | `registration_url: null` |
| `sources/elektronicznezapisy.js` | `registration_url: null` |
| `sources/biegiwpolsce.js` | `registration_url: null` |
| `urlResolver.js` | Auto-assign top Brave result to `registration_url` + audit trail |
| `llmEnricher.js` | Full rewrite: Playwright page fetch + Claude for all missing fields + `enriched_at` |

## Not Changing

- `index.js` (orchestrator) — pipeline order stays the same, already calls `resolveUrls()` then `enrichDistances()`
- `normalizer.js` — still does its job for initial data from scrapers
- `dedup.js` — upsert logic unchanged
- `geocoder.js` — still geocodes during normalization
- Kalendarz UI / FilterBar — no changes needed, fields already supported

## Testing

1. Run Supabase migration to add `enriched_at` column
2. Clear `calendar_events` table (backup already saved locally)
3. Run full pipeline: `POST /api/scrapers/run`
4. Verify: events have official URLs (not maratonypolskie.pl links), enriched fields populated, `enriched_at` set
5. Run pipeline again — verify only new events get processed (enriched_at skip logic)
