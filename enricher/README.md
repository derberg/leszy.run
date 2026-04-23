# LeszyRun Event Enricher

Local LLM pipeline that enriches running event data in `scraper_all` (Supabase) with prices, deadlines, websites, and event classifications. Uses Ollama for extraction, SearXNG for URL discovery, Crawl4AI for page crawling, and Docling for PDF parsing.

## Setup

```bash
cd enricher
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env  # fill in Supabase credentials
```

### Dependencies

- **Ollama** — running locally with `gemma3:27b` model
- **SearXNG** — Docker container for web search (finding missing URLs)
- **Crawl4AI** — headless browser for crawling SPAs (dostartu.pl etc.)
- **Docling** — PDF text extraction for regulamin documents

```bash
# Start SearXNG
docker compose up -d

# Verify Ollama has the model
ollama list | grep gemma3
# If missing: ollama pull gemma3:27b
```

## Commands

### `enricher run` — Enrich events

Processes un-enriched events in `scraper_all` through 6 steps: URL validation → SearXNG search → Crawl4AI crawl → Docling PDF extraction → Ollama LLM extraction → smart merge.

```bash
python -m enricher run                    # all un-enriched future events
python -m enricher run --limit 10         # first 10 only
python -m enricher run --dry-run          # preview without writing
python -m enricher run --force            # re-process already-enriched events
python -m enricher run --incomplete       # re-process enriched events still missing fields
python -m enricher run --resume           # skip events from most recent run log
python -m enricher run --force --limit 5  # re-enrich 5 events
```

**Flags:**
- `--dry-run` — shows what would change, doesn't write to Supabase
- `--force` — re-processes events that already have `enriched_at` set
- `--incomplete` — re-processes already-enriched future events that are still missing at least one enrichable field (`registration_url`, `regulamin_url`, `website`, `registration_deadline`, `price_from`, `voivodeship`, `is_kids`, `distances`, `event_types`). `price_to` alone is ignored when `price_from` is set, since many events have a single flat fee. Mutually exclusive with `--force`.
- `--resume` — skips events already in the most recent JSONL run log
- `--limit N` — process at most N events

**Performance:** ~2 min/event (mostly LLM inference on the 27B model).

### `enricher sync` — Push to calendar_events

After enrichment, pushes data from `scraper_all` to the public `calendar_events` table. Matches by `source+source_id`.

```bash
python -m enricher sync --since today --dry-run   # preview today's changes
python -m enricher sync --since yesterday          # push yesterday + today
python -m enricher sync --since 2026-04-04         # from specific date
python -m enricher sync                            # push ALL enriched events
```

**Output shows before → after for each field:**
```
  WOULD UPDATE: Dyszka z Kija – Marsz Nordic Walking 2026
    price_from                (empty) → 50
    price_to                  (empty) → 150
    registration_deadline     (empty) → 2026-04-09
    website                   (empty) → https://www.kuzniakultury.pl
```

### `audit` — URL review (report-only by default, `--apply` nulls mismatches)

`audit` reviews outbound URL fields on `calendar_events` (future events only) and writes a JSONL report of how each URL looks to an LLM. By default it is read-only. With `--apply`, any URL the LLM calls a `mismatch` at confidence ≥ `--apply-confidence` (default 0.8) is set to NULL on BOTH `calendar_events` AND the matching row in `scraper_all` (matched by `source` + `source_id`, with a safety check that the scraper_all URL still equals the audited URL). Match / uncertain / skipped rows are never touched. After applying, run `python -m enricher run --incomplete` to re-fill the nulled fields on scraper_all, then `python -m enricher sync` to push them to calendar_events.

```bash
# Audit all future events' `website` URLs (report only)
python -m enricher audit

# Limit, custom date, multiple fields, custom threshold
python -m enricher audit --limit 50 \
    --since 2026-05-01 \
    --fields website,registration_url \
    --confidence-threshold 0.85

# Apply decisions: null mismatched URLs on calendar_events
python -m enricher audit --apply
python -m enricher audit --apply --apply-confidence 0.9   # stricter bar
```

**Verdicts** (one JSONL line per `(event_id, field)`):
- `match` — the URL is clearly about this event
- `mismatch` — the URL points to a different / wrong-year / unrelated page
- `uncertain` — LLM could not tell from the content
- `skipped_social` — Facebook / Instagram / YouTube etc. — left alone
- `skipped_dead` — HTTP 4xx/5xx, timeout, non-HTML response
- `error` — LLM call failed or returned unparseable output

**Hybrid path:** fast HTTP fetch + HTML parse first (cheap). Falls back to Crawl4AI full crawl when fast-path content is thin (title < 10 chars OR body < 500 chars), when verdict is `uncertain`, or when confidence < `--confidence-threshold` (default 0.8).

Report file: `enricher/logs/audit-<timestamp>.jsonl`. Shape per line:
```json
{"event_id": "...", "event_name": "...", "event_date": "...",
 "event_location": "...", "event_voivodeship": "...",
 "field": "website", "url": "...", "final_url": "...",
 "verdict": "match", "confidence": 0.92, "path": "fast",
 "reasoning": "...", "evidence": {"title": "...", "h1": [...], "body_sample": "..."},
 "checked_at": "2026-04-20T14:32:10+00:00"}
```

### `locked_fields` on calendar_events

When an admin edits a data field via the admin UI / PATCH endpoint, that field name is auto-appended to `calendar_events.locked_fields`. The enricher `sync` command never overwrites a locked field, so human corrections are sticky. To unlock, edit `locked_fields` directly (the admin endpoint respects an explicit `locked_fields` value in the request body).

## What it enriches

| Field | Source | Notes |
|-------|--------|-------|
| `registration_url` | LLM extracts from page content, fallback to SearXNG search | Replaces empty/dead URLs (only with a validated candidate). LLM reads actual pages to find signup links. |
| `regulamin_url` | LLM extracts from page content or PDF links, fallback to SearXNG search | Replaces empty/dead URLs (only with a validated candidate). Downloads and extracts PDFs via Docling. |
| `website` | SearXNG search + LLM validation | LLM validates it's the official event site (not news/social/aggregator). |
| `distances` | Regulamin PDFs (Docling), registration pages, website content (Crawl4AI) | Only overwrites if LLM found MORE distances than existing (more complete data wins). |
| `event_types` | LLM classification from all content sources | `[trail, uliczny, nocny, ocr, nordic walking, ultra, charytatywny]`. Additive merge with safety rules (never downgrades trail/ocr → uliczny). |
| `price_from` | Regulamin PDF, registration page | Cheapest adult entry tier (early-bird). Regulamin prices prioritized. Looks for "opłata startowa" tables with date tiers. |
| `price_to` | Regulamin PDF, registration page | Most expensive adult entry tier (race-day/"w dniu biegu"). Regulamin prices prioritized. |
| `registration_deadline` | Regulamin, registration page | Last date to sign up (YYYY-MM-DD format). Rejects deadlines >1 year from event date (catches hallucinations). |
| `voivodeship` | LLM extraction (only if empty) | NEVER overwrites existing — scraper's geocoded value is more reliable. |
| `is_kids` | LLM detection from all content | true if any distance ≤ 1 km OR dedicated children's category exists. |

## How it works

### Pipeline steps (per event)

1. **URL Validation** — HEAD check on existing registration_url, regulamin_url, website. Classifies as alive/dead/PDF.
2. **SearXNG Search** — for missing or dead URLs, searches the web for the event. Filters out aggregator domains.
3. **Crawl4AI** — crawls alive URLs with headless browser (`wait_until=networkidle` for SPAs like dostartu.pl). Gets markdown content.
4. **Docling PDF** — downloads and extracts text from PDF regulamins. Falls back to crawling if PDF download fails (SPA wrappers).
5. **Keyword Chunk Extraction** — scans all content for price/deadline/distance keywords. Extracts focused text windows around matches. These chunks go at the top of the LLM prompt so prices are impossible to miss.
6. **Ollama LLM** — sends event data + focused chunks + raw content to gemma3:27b. Returns structured JSON.
7. **Smart Merge** — compares LLM output with existing data. Safety rules prevent bad updates.

### Smart merge rules

**Prices:**
- Regulamin prices are authoritative (prompt instructs LLM to prefer them)
- price_from must be ≤ price_to (rejects if swapped)
- Allows 0 for free events ("bezpłatne")
- Rejects negative prices

**Event types:**
- Never downgrades specific types (trail, ocr, charytatywny) to the generic default (uliczny)
- When LLM has page content: can add new types, can upgrade uliczny → trail
- When LLM has no content: additive only, respects terrain conflicts (trail vs uliczny)
- "przełajowy", "cross", "górski" → always trail

**URLs:**
- Never nulls a working URL without a replacement candidate
- Dead URLs only replaced when SearXNG found an alternative
- Aggregator/news URLs blocked from replacing official websites

**Voivodeship:**
- Only fills empty — never overwrites existing (scraper has geocoding evidence)

**Registration deadline:**
- Must be YYYY-MM-DD format
- Rejected if more than 1 year from event date (catches LLM year hallucinations)

## Logs

Run logs are JSONL files in `logs/` (or repo root `logs/` depending on working directory). One file per run, named `run-YYYY-MM-DDTHHMMSS.jsonl`. Used for `--resume` support.

## Tests

```bash
cd enricher
source .venv/bin/activate
python -m pytest tests/ -v
```

## Typical workflow

```bash
cd enricher && source .venv/bin/activate

# 1. Start SearXNG
docker compose up -d

# 2. Enrich new events
python -m enricher run

# 3. Review what would be pushed to calendar_events
python -m enricher sync --since today --dry-run

# 4. Push to public table
python -m enricher sync --since today
```
