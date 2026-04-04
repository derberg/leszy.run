# Local LLM Enricher — Design Spec

**Date:** 2026-04-04
**Goal:** Replace paid Claude API enrichment with a local, self-hosted pipeline using Ollama (qwen2.5:72b), SearXNG, Crawl4AI, and Docling. Smarter than current scripts — validates existing data, extracts all fields in one pass, and auto-fixes bad URLs.

---

## Architecture Overview

New `enricher/` Python project at monorepo root, alongside `backend/`, `frontend/`, `public/`.

```
BeepBeep/
  enricher/
    pyproject.toml
    enricher/
      __init__.py
      __main__.py           # CLI: python -m enricher run [flags]
      config.py             # env-based config (Ollama, SearXNG, Supabase URLs)
      pipeline.py           # main per-event sequential loop
      steps/
        validate_urls.py    # HEAD-check all URLs, classify content type
        search.py           # SearXNG search for missing/dead URLs
        crawl.py            # Crawl4AI: fetch page content as markdown
        pdf.py              # Docling: extract text from PDF regulamins
        llm.py              # Ollama qwen2.5:72b — single call per event
        merge.py            # smart merge: compare old vs new, decide overwrites
      logging.py            # JSONL run logger
    docker-compose.yml      # SearXNG container
    searxng-settings.yml    # SearXNG config (JSON API, Polish, search engines)
    logs/                   # JSONL run logs (gitignored)
```

### Services

| Service | How it runs | URL |
|---------|------------|-----|
| Ollama (qwen2.5:72b-instruct-q4_0) | Native macOS (already installed) | http://localhost:11434 |
| SearXNG | Docker container (enricher/docker-compose.yml) | http://localhost:8888 |
| Crawl4AI | Python library (pip, uses Playwright) | N/A (in-process) |
| Docling | Python library (pip) | N/A (in-process) |

### Why not dockerize everything?

- Ollama on macOS needs Metal GPU access — Docker can't provide that
- Crawl4AI and Docling are pure Python libs, no need for containers
- Only SearXNG benefits from Docker (complex config, Redis, etc.)

---

## Per-Event Processing Flow

For each event in `scraper_all` where `enriched_at IS NULL`:

### Step 1: Validate existing URLs

HTTP HEAD request to every URL on the event:
- `registration_url`
- `regulamin_url`
- Each entry in `regulamin_urls[]`
- `website`

Classify each as: `alive` (2xx), `redirect` (3xx → follow and record final URL), `dead` (4xx/5xx/timeout), `not-pdf` (regulamin URL that doesn't serve a PDF).

Dead URLs are nulled out and flagged for replacement in Step 2.

Timeout: 10s per URL. Concurrency: sequential (no parallel requests to avoid looking like a bot).

### Step 2: Search for missing/dead URLs (SearXNG)

Only runs if the event is missing `registration_url`, `regulamin_url`, or `website` (either originally empty or nulled in Step 1).

**Search queries:**
- Missing registration: `"{name} {year} zapisy rejestracja {location}"`
- Missing regulamin: `"{name} {year} regulamin"`
- Missing website: `"{name} {year} {location}"`

**SearXNG API call:**
```
GET http://localhost:8888/search?q=...&format=json&language=pl&categories=general
```

**Aggregator domain blocklist** (same as current urlResolver.js):
- maratonypolskie.pl, datasport.pl, biegiwpolsce.pl, elektronicznezapisy.pl
- bieganie.pl, kalendarzbiegowy.pl, enduhub.com

Pick the top non-aggregator result per URL type. Store as candidate — final validation happens in Step 5 (LLM confirms if the page is what we think it is).

### Step 3: Crawl web pages (Crawl4AI)

Fetch content from all valid URLs using Crawl4AI's async crawler:
- `registration_url` (original or SearXNG candidate)
- `website` (if different from registration_url)
- `regulamin_url` (only if it's HTML, not PDF)

Crawl4AI returns clean markdown (not raw HTML). This is much better for LLM consumption than the current Playwright `document.body.innerText` approach.

Max 10,000 chars per page. If a page fails to load, log it and continue.

Browser instance is reused across pages within one event (Crawl4AI manages this internally).

### Step 4: Extract from PDFs (Docling)

If `regulamin_url` points to a PDF (detected in Step 1 via Content-Type):
1. Download the PDF (same download logic as current `run-enrich-from-regulamin.js` — check size, detect HTML-served-as-PDF)
2. Docling parses it into structured text — handles tables, multi-column layouts, Polish diacritics
3. Output: plain text, max 15,000 chars (regulamins can be long)

No LLM needed for extraction — Docling handles the document understanding. The text feeds into Step 5.

### Step 5: LLM — single Ollama call

One call to `qwen2.5:72b-instruct-q4_0` per event, with ALL gathered context:

**Prompt structure:**
```
You are extracting structured data about a Polish running/walking race event.

Event name: {name}
Event date: {date}
Event location: {location}
Currently known data:
  distances: {distances or "unknown"}
  event_types: {event_types or "unknown"}
  registration_deadline: {registration_deadline or "unknown"}
  price: {price_from}-{price_to} or "unknown"
  voivodeship: {voivodeship or "unknown"}

--- WEBSITE CONTENT ({website_url}) ---
{crawled markdown, max 10000 chars}

--- REGISTRATION PAGE ({registration_url}) ---
{crawled markdown, max 10000 chars}

--- REGULAMIN ({regulamin_url}) ---
{docling text or crawled markdown, max 15000 chars}

Extract ALL of the following. Return ONLY valid JSON:
{
  "distances": ["5 km", "10 km", "21.1 km", "6h", "200m"],
  "event_types": ["uliczny", "trail", ...],
  "registration_deadline": "YYYY-MM-DD" or null,
  "price_from": number (PLN, e.g. 50) or null,
  "price_to": number (PLN, e.g. 120) or null,
  "voivodeship": "one of 16" or null,
  "is_kids": true/false,
  "website": "https://..." or null,
  "registration_url": "https://..." or null,
  "regulamin_url": "https://..." or null,
  "url_is_regulamin": true/false,
  "url_is_registration": true/false
}

[... detailed extraction rules for distances, event types, prices, etc. ...]
[... same classification rules as current scripts ...]
```

**Ollama API call:**
```
POST http://localhost:11434/api/generate
{
  "model": "qwen2.5:72b-instruct-q4_0",
  "prompt": "...",
  "stream": false,
  "options": { "temperature": 0.1, "num_predict": 1024 }
}
```

Low temperature (0.1) for deterministic extraction. `num_predict: 1024` caps output length.

Expected inference time: 30-60s per event on M3 Pro 48GB.

### Step 6: Smart merge into scraper_all

#### Rule 1: Empty → always fill
Null/empty field + LLM returned a value → write it.

#### Rule 2: URL replacement
- Dead URL (404/timeout from Step 1) → replace with SearXNG candidate, or null if none found
- LLM says `url_is_regulamin: false` → replace regulamin_url with SearXNG candidate or null
- LLM says `url_is_registration: false` → replace registration_url with SearXNG candidate or null
- Working URL confirmed by LLM → keep as-is

#### Rule 3: Distances — overwrite if more complete
Distances can be km-based ("5 km"), time-based ("6h", "12h"), or meter-based ("200m").
- Compare by total entry count across all types
- Current has 2 entries, LLM found 4 → overwrite
- Current has 3, LLM found 2 → keep current
- Same count, different values → keep current

#### Rule 4: Event types — additive merge
- New types merged into existing array
- Conflicting terrain types not mixed (trail + uliczny → keep existing terrain)
- Never remove an existing type

#### Rule 5: Scalar fields (price, deadline, voivodeship)
- Empty → fill
- Already set → overwrite (LLM reads the actual source material, more authoritative than scraper guesses)

#### Rule 6: enriched_at always set
Even if no changes, stamp `enriched_at = now()` to prevent re-processing.

---

## CLI Interface

```bash
# Navigate to enricher
cd enricher

# Process all un-enriched events
python -m enricher run

# Limit to N events
python -m enricher run --limit 5

# Dry run — show what would change, don't write to Supabase
python -m enricher run --dry-run

# Resume — skip events already processed in most recent run log
python -m enricher run --resume

# Force — re-process even if enriched_at is set
python -m enricher run --force

# Combine flags
python -m enricher run --limit 10 --dry-run
```

---

## Logging

### JSONL run log

Written to `enricher/logs/run-<timestamp>.jsonl`. One line per step per event:

```json
{"id": "uuid", "name": "Bieg Leszka", "step": "validate", "urls_checked": 3, "dead": ["regulamin_url"], "ts": "2026-04-04T14:30:00Z"}
{"id": "uuid", "name": "Bieg Leszka", "step": "search", "queries": 2, "found": {"registration_url": "https://..."}, "ts": "2026-04-04T14:30:01Z"}
{"id": "uuid", "name": "Bieg Leszka", "step": "crawl", "pages": 2, "total_chars": 8420, "ts": "2026-04-04T14:30:05Z"}
{"id": "uuid", "name": "Bieg Leszka", "step": "pdf", "extracted_chars": 3200, "ts": "2026-04-04T14:30:08Z"}
{"id": "uuid", "name": "Bieg Leszka", "step": "llm", "model": "qwen2.5:72b-instruct-q4_0", "duration_s": 45, "ts": "2026-04-04T14:30:53Z"}
{"id": "uuid", "name": "Bieg Leszka", "step": "merge", "fields_updated": ["distances", "price_from"], "fields_replaced": ["regulamin_url"], "ts": "2026-04-04T14:30:53Z"}
```

### Console output

```
[1/342] Bieg Leszka | 2026-05-10 | Warszawa
    validate: 3 URLs checked, 1 dead (regulamin_url → 404)
    search: found regulamin_url via SearXNG
    crawl: 2 pages, 8420 chars
    pdf: regulamin extracted, 3200 chars
    llm: 45s, extracted 8 fields
    ✓ distances: (none) → 5 km, 10 km
    ✓ price_from: (none) → 50
    ✓ regulamin_url: (dead) → https://new-url.pl/regulamin.pdf

[2/342] Maraton Krakowski | 2026-06-15 | Kraków
    validate: 2 URLs checked, all alive
    crawl: 2 pages, 12300 chars
    llm: 52s, extracted 3 fields
    — no changes (all fields already set)
```

### Resume logic

On `--resume`, reads the most recent `run-*.jsonl` file, collects event IDs that have a `merge` step entry (= completed), skips those.

---

## Supabase Column Addition

New column on `scraper_all`:
- `enriched_at` — **already exists** (timestamptz, nullable). Set after enrichment completes.

No schema changes needed. The existing `enriched_at`, `enriched_regulamin_at`, and `enriched_search_at` columns remain — the new enricher uses `enriched_at` as its single "done" flag (it replaces all three old enrichment scripts).

---

## Smart Behaviors (vs. Current Scripts)

| Current scripts | New enricher |
|----------------|-------------|
| Separate scripts for regulamin PDF, web search, page crawl | Single pipeline does all in one pass |
| Claude API (paid: haiku $0.25/1M, sonnet $3/1M) | Local Ollama (free, ~45s/event) |
| Brave Search API (1000 queries/month free) | SearXNG (unlimited, self-hosted) |
| Playwright (raw innerText, misses SPAs) | Crawl4AI (clean markdown, JS rendering, lazy-load) |
| fetch + pdf-lib for PDFs | Docling (tables, multi-column, OCR-capable) |
| Only fills empty fields | Validates + fixes existing data (dead URLs, wrong URLs) |
| 3 separate enriched_at timestamps | Single enriched_at (one pass does everything) |
| Skips events that have data | Re-extracts all fields (free when LLM already called) |

---

## Setup Instructions

### Prerequisites

- Python 3.10+ (macOS: `brew install python@3.12`)
- Docker (for SearXNG)
- Ollama installed (`brew install ollama`)

### 1. Pull the Ollama model

```bash
ollama pull qwen2.5:72b-instruct-q4_0
```

Verify it works:
```bash
ollama run qwen2.5:72b-instruct-q4_0 "Say hello in Polish"
```

### 2. Start SearXNG

```bash
cd enricher
docker compose up -d
```

Verify it works:
```bash
curl "http://localhost:8888/search?q=test&format=json" | head -c 200
```

### 3. Set up Python environment

```bash
cd enricher
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 4. Install Crawl4AI browser

```bash
crawl4ai-setup
```

This installs Playwright's Chromium browser for Crawl4AI.

### 5. Environment variables

Create `enricher/.env`:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OLLAMA_URL=http://localhost:11434
SEARXNG_URL=http://localhost:8888
```

### 6. Run enrichment

```bash
cd enricher
source .venv/bin/activate

# Test with 3 events first
python -m enricher run --limit 3 --dry-run

# If output looks good, apply
python -m enricher run --limit 3

# Full run (fire and forget)
python -m enricher run
```

---

## Performance Estimates (M3 Pro 48GB)

| Step | Time per event | Notes |
|------|---------------|-------|
| URL validation | 1-5s | Sequential HEAD requests, 10s timeout each |
| SearXNG search | 1-3s | Only if URLs missing/dead |
| Crawl4AI | 3-8s | JS rendering, lazy-load handling |
| Docling PDF | 2-5s | Only if regulamin is PDF |
| Ollama inference | 30-60s | Bottleneck. 72B model, ~15 tok/s on M3 Pro |
| **Total per event** | **~40-80s** | |
| **1000 events** | **~11-22 hours** | First run only; subsequent runs much smaller |

RAM usage: ~40GB for Ollama + ~2GB for Chromium (Crawl4AI) + ~1GB for Python/Docling = ~43GB. Fits in 48GB but tight. Crawl4AI browser is released between events to help. After a run completes, `ollama stop qwen2.5:72b-instruct-q4_0` frees the 40GB back.

---

## Future: OpenCrabs Scheduling

Not implemented now (manual invocation only). When ready:

```bash
opencrabs cron add \
  --name "enricher" \
  --cron "0 4 * * *" \
  --prompt "cd /path/to/BeepBeep/enricher && source .venv/bin/activate && python -m enricher run"
```

---

## Dependencies (pyproject.toml)

```toml
[project]
name = "leszyrun-enricher"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "crawl4ai>=0.8.0",
    "docling>=2.70.0",
    "httpx>=0.27.0",
    "supabase>=2.0.0",
    "click>=8.0.0",
]

[project.scripts]
enricher = "enricher.__main__:main"
```
