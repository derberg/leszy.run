# Scraper Merge Design — Priority-Based Dedup via `scraper_all`

## Problem

Current dedup fills empty fields but **never overwrites**. First source to create a row "owns" it.
This means if maratonypolskie (low quality) creates an event first, dostartu's better data gets ignored.

## Solution

**Two-phase merge with priority-based dedup.**

```
scraper_dostartu  ─┐
scraper_biegiwpolsce ─┤
scraper_elektronicznezapisy ─┤──► scraper_all ──► (normalize + geocode) ──► calendar_events
scraper_datasport ─┤
scraper_maratonypolskie ─┘
```

**Phase 1** — Raw `scraper_*` tables → `scraper_all` (priority-based dedup, no normalization)
**Phase 2** — `scraper_all` → `calendar_events` (normalize, geocode, classify, upsert)

## Source Priority (highest → lowest)

| Rank | Source | Why |
|------|--------|-----|
| 1 | **dostartu** | Only API source. Has coordinates, structured distances, registration URLs, end_date, regulamin |
| 2 | **biegiwpolsce** | 1000+ events, has registration URLs, regulamin, voivodeship, event types, kids flag |
| 3 | **elektronicznezapisy** | Has registration URLs, regulamin PDFs, detects cross-source links |
| 4 | **datasport** | Good distance extraction, has regulamin PDF, but no registration URL |
| 5 | **maratonypolskie** | Listing only — name, date, location, single distance. No URLs |

## `scraper_all` Table Schema

Union of all raw scraper fields + `source_links` for multi-source tracking.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL — from highest-priority source |
| date | date | NOT NULL |
| end_date | date | Only dostartu provides this |
| location | text | |
| voivodeship | text | Only biegiwpolsce provides this raw |
| lat | numeric | Only dostartu provides this |
| lng | numeric | Only dostartu provides this |
| distances | text | Raw distance string (not yet parsed into array) |
| event_type | text | Single type from dostartu |
| event_types | text[] | Type array from biegiwpolsce |
| registration_url | text | |
| regulamin_url | text | Single URL (or first from regulamin_urls) |
| regulamin_urls | text[] | Array from elektronicznezapisy |
| website | text | From elektronicznezapisy's external_website |
| is_kids | boolean | From dostartu or biegiwpolsce |
| source | text | NOT NULL — highest-priority source name |
| source_id | text | UNIQUE per source |
| source_url | text | |
| source_links | jsonb | All sources that matched: `[{source, source_id, source_url}, ...]` |
| merged_at | timestamptz | |
| created_at | timestamptz | |

**Unique constraint:** `(source, source_id)`

## Field Mapping: Raw Scraper Tables → `scraper_all`

### Legend
- ✅ = source provides this field
- ❌ = source never has this field

| `scraper_all` column | dostartu (1) | biegiwpolsce (2) | elektronicznezapisy (3) | datasport (4) | maratonypolskie (5) |
|----------------------|:---:|:---:|:---:|:---:|:---:|
| `name` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `date` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `end_date` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `location` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `voivodeship` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `lat` | ✅ (API) | ❌ | ❌ | ❌ | ❌ |
| `lng` | ✅ (API) | ❌ | ❌ | ❌ | ❌ |
| `distances` | ✅ (highest quality) | ✅ (from tags) | ✅ (from pricing) | ✅ (from h4) | ✅ (single value) |
| `event_type` | ✅ (from API type) | ❌ | ❌ | ❌ | ❌ |
| `event_types` | ❌ | ✅ (from tags) | ❌ | ❌ | ❌ |
| `registration_url` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `regulamin_url` | ✅ | ✅ | ✅ (first of array) | ✅ | ❌ |
| `regulamin_urls` | ❌ | ❌ | ✅ | ❌ | ❌ |
| `website` | ❌ | ❌ | ✅ (`external_website`) | ❌ | ❌ |
| `is_kids` | ✅ | ✅ | ❌ | ❌ | ❌ |

## Phase 1: Merge Rules (raw → `scraper_all`)

Sources processed in priority order: dostartu → biegiwpolsce → elektronicznezapisy → datasport → maratonypolskie.

**For each raw event:**
1. Find match in `scraper_all` (exact `source_links` match, then fuzzy: same date + name similarity + city)
2. If match found:
   - Compare incoming source priority vs existing row's `source` priority
   - **Higher priority wins** → overwrite all non-null fields
   - **Lower priority** → only fill fields that are currently NULL/empty
   - Always add to `source_links`
3. If no match → insert new row

## Phase 2: Normalize Rules (`scraper_all` → `calendar_events`)

For each `scraper_all` row:
1. **Normalize** via `normalizeEvent()`:
   - Clean location string
   - Parse date (ISO/EU/Polish months)
   - Parse distances from text → array (`["5 km", "10 km", "21.1 km"]`)
   - Classify event type from keywords (or use raw `event_type`/`event_types`)
   - Geocode if no lat/lng (Nominatim + cache)
   - Detect voivodeship (scraper data > geocoder > city map)
2. **Upsert** into `calendar_events`:
   - Match by `source_links` jsonb or fuzzy (same as phase 1)
   - Since `scraper_all` already has best data, always overwrite scraper fields
   - Never touch protected fields (price, deadline, surface, etc. — LLM/manual only)
   - Pass through `source_links` from `scraper_all`

## Protected Fields (never overwritten by merge)

These are only set by LLM enricher or manual admin edits:

| Field | Set by |
|-------|--------|
| `status` | Admin (pending/active/rejected) |
| `registration_deadline` | LLM enricher |
| `price_from` / `price_to` | LLM enricher |
| `surface` | LLM enricher |
| `elevation_gain_m` | LLM enricher |
| `max_participants` | LLM enricher |
| `is_recurring` / `recurring_event_id` / `edition_number` | Manual |
| `leszyrun_event_id` | Manual |
| `enriched_at` | LLM enricher |

## API Endpoints

| Endpoint | What it does |
|----------|-------------|
| `POST /api/scrapers/run` | Scrape raw data into `scraper_*` tables |
| `POST /api/scrapers/merge` | Phase 1 + Phase 2: raw → `scraper_all` → `calendar_events` |
| `POST /api/scrapers/enrich` | LLM enricher on `calendar_events` |
| `POST /api/scrapers/resolve-urls` | Brave Search for missing registration URLs |

## Example Scenario

"Bieg Nocny Kraków" exists in 3 sources:

1. **dostartu** processed first (rank 1): creates `scraper_all` row with name, date, location, `lat/lng`, `distances: "5 km, 10 km, 21.1 km"`, `registration_url`, `regulamin_url`
2. **biegiwpolsce** matches it (rank 2): adds `voivodeship` (was empty), `event_types` (was empty). Does NOT overwrite name, distances, registration_url (dostartu's are better)
3. **maratonypolskie** matches it (rank 5): nothing to add — all fields already filled by higher-priority sources

Final `scraper_all` row has dostartu's core data, biegiwpolsce's voivodeship + event types, and `source_links` tracking all 3.

Phase 2 normalizes this into `calendar_events`: distances parsed to array, event type classified, location geocoded (or uses dostartu's lat/lng).
