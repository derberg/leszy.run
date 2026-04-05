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

- **Ollama** — running locally with `qwen2.5-coder:32b` model
- **SearXNG** — Docker container for web search (finding missing URLs)
- **Crawl4AI** — headless browser for crawling SPAs (dostartu.pl etc.)
- **Docling** — PDF text extraction for regulamin documents

```bash
# Start SearXNG
docker compose up -d

# Verify Ollama has the model
ollama list | grep qwen2.5-coder
# If missing: ollama pull qwen2.5-coder:32b
```

## Commands

### `enricher run` — Enrich events

Processes un-enriched events in `scraper_all` through 6 steps: URL validation → SearXNG search → Crawl4AI crawl → Docling PDF extraction → Ollama LLM extraction → smart merge.

```bash
python -m enricher run                    # all un-enriched future events
python -m enricher run --limit 10         # first 10 only
python -m enricher run --dry-run          # preview without writing
python -m enricher run --force            # re-process already-enriched events
python -m enricher run --resume           # skip events from most recent run log
python -m enricher run --force --limit 5  # re-enrich 5 events
```

**Flags:**
- `--dry-run` — shows what would change, doesn't write to Supabase
- `--force` — re-processes events that already have `enriched_at` set
- `--resume` — skips events already in the most recent JSONL run log
- `--limit N` — process at most N events

**Performance:** ~2 min/event (mostly LLM inference on the 32B model).

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

## What it enriches

| Field | Source | Notes |
|-------|--------|-------|
| `price_from` | Regulamin PDF, registration page | Cheapest tier (early-bird) |
| `price_to` | Regulamin PDF, registration page | Most expensive tier (race-day) |
| `registration_deadline` | Regulamin, registration page | Last date to sign up |
| `website` | SearXNG search | Event's official website |
| `event_types` | LLM classification from content | trail, uliczny, nocny, ocr, nordic walking, ultra, charytatywny |
| `distances` | Regulamin, registration page | Only if LLM found MORE than existing |
| `registration_url` | SearXNG, LLM validation | Replaces dead URLs (only with a candidate) |
| `regulamin_url` | SearXNG, LLM validation | Replaces dead URLs (only with a candidate) |
| `is_kids` | LLM detection | Any distance ≤ 1km or kids category |

## How it works

### Pipeline steps (per event)

1. **URL Validation** — HEAD check on existing registration_url, regulamin_url, website. Classifies as alive/dead/PDF.
2. **SearXNG Search** — for missing or dead URLs, searches the web for the event. Filters out aggregator domains.
3. **Crawl4AI** — crawls alive URLs with headless browser (`wait_until=networkidle` for SPAs like dostartu.pl). Gets markdown content.
4. **Docling PDF** — downloads and extracts text from PDF regulamins. Falls back to crawling if PDF download fails (SPA wrappers).
5. **Keyword Chunk Extraction** — scans all content for price/deadline/distance keywords. Extracts focused text windows around matches. These chunks go at the top of the LLM prompt so prices are impossible to miss.
6. **Ollama LLM** — sends event data + focused chunks + raw content to qwen2.5-coder:32b. Returns structured JSON.
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
