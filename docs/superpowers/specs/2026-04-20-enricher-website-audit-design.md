# Enricher — AI-Driven Website Audit (Report-Only)

## Purpose

Add a new enricher subcommand that audits outbound URLs on `calendar_events` (currently just `website`; extensible to `registration_url` and `regulamin_url`) and produces an AI-digestible report identifying URLs that do not actually belong to the event they are attached to. The report is read-only — no DB writes. A separate, later workflow consumes the report to null bad URLs or requeue events for enrichment.

## Scope

**In scope**
- New `audit` subcommand in the existing Python enricher (`enricher/enricher/__main__.py`).
- Targets `calendar_events` rows with `date >= today`, all statuses.
- Audits the `website` field first. Report schema and code are shaped so `registration_url` and `regulamin_url` can be added later via `--fields`.
- Hybrid analysis: fast HTTP fetch + LLM, falling back to Crawl4AI + LLM on uncertainty, thin content, or low confidence.
- Skips Facebook and other unscannable social hosts — recorded as `skipped_social`, URL left untouched.
- Writes a JSONL report to `enricher/logs/audit-<timestamp>.jsonl` plus a concise stdout summary.
- Adds a `locked_fields text[]` column to `calendar_events` and teaches the publish/sync write paths to respect it, so a field nulled (or manually corrected) after an audit is not overwritten by the next publish/sync.

**Out of scope for this iteration**
- Any automated DB mutation based on the report.
- Auditing `scraper_all` or rejected `calendar_events` rows.
- UI surfaces for the report (admin panel). The report is a file.
- Auditing past events.

## Non-goals / explicit decisions

- **Report-only.** The audit never nulls, updates, or flags rows in the database.
- **Future events only** (`date >= today`, computed in UTC to match existing enricher behavior).
- **Facebook URLs are left alone.** They are logged as `skipped_social` for transparency but not analyzed and not flagged as bad.
- **No new Ollama model.** Reuses the currently configured `gemma3:27b`.
- **No background scheduling.** Audits are manual, invoked on demand.

## CLI

```
python -m enricher audit [--limit N] [--fields F1,F2] [--since YYYY-MM-DD] [--confidence-threshold X]
```

| Flag | Default | Meaning |
|---|---|---|
| `--limit` | none | Max events to process (testing) |
| `--fields` | `website` | Comma-separated URL fields to audit |
| `--since` | today (UTC) | Lower bound on `calendar_events.date` |
| `--confidence-threshold` | `0.8` | Fast-path verdicts below this trigger fallback |

## Event selection

```sql
SELECT id, name, date, location, voivodeship, distances, event_types,
       website, registration_url, regulamin_url, status
FROM calendar_events
WHERE date >= :since
  AND status != 'rejected'
  AND (<selected field> IS NOT NULL)
```

Performed via `supabase-py` with `.range()` pagination (PostgREST caps at 1000 rows server-side — this is explicitly addressed in existing code and memory; the audit fetcher paginates identically to `fetch_events` in `pipeline.py`).

One audit row is produced per `(event, field)` pair — if `--fields website,registration_url` is passed and both are non-null, the event yields two report lines.

## Per-event flow (hybrid)

### Step 1 — Early skips (no LLM call)

For the URL under audit:

- **Facebook / social hosts** (`facebook.com`, `www.facebook.com`, `m.facebook.com`, `fb.com`, `instagram.com`, plus whatever the existing `navigate.py` social set grows to): emit `verdict: skipped_social`, do not fetch.
- **Dead URL** (HTTP error, DNS failure, 4xx/5xx, timeout): emit `verdict: skipped_dead`, include the status in the report.

Dead/skip results still go into the report so downstream tools can act on them.

### Step 2 — Fast path

Plain HTTP fetch (reuse `validate_urls` HEAD/GET helpers or a light `httpx` call — whichever already exists). Parse with a small helper:

- `<title>` text
- First `<meta name="description">` content
- All `<h1>` text (up to a small cap)
- First 2 KB of body text stripped of HTML

Build a compact prompt:

> You are checking whether a webpage really represents a specific running event. Reply as JSON: `{"verdict": "match"|"mismatch"|"uncertain", "confidence": 0.0-1.0, "reasoning": "..."}`.
>
> Event facts: name, date, year, city, voivodeship, known distances.
> Page: title, meta, h1, body sample.

Parse the JSON. The fast path is trusted and the result is used **only when all of these hold**:

- `confidence >= --confidence-threshold`
- Fast-path content is non-trivial: title ≥ 10 chars **and** body sample ≥ 500 chars
- Verdict is not `uncertain`

Otherwise go to Step 3.

### Step 3 — Full-path fallback

Reuse `enricher.steps.crawl.crawl_pages` (Crawl4AI, networkidle wait, handles SPA). Build a richer prompt with up to `config.max_page_chars` of content. Same JSON output shape. The fallback verdict is authoritative — its confidence is reported as-is, even if below threshold.

### Step 4 — Emit report line

One JSONL line per (event_id, field), regardless of verdict:

```json
{
  "event_id": "<uuid>",
  "event_name": "Maraton Warszawski 2026",
  "event_date": "2026-04-20",
  "event_location": "Warszawa",
  "event_voivodeship": "mazowieckie",
  "field": "website",
  "url": "https://example.pl",
  "final_url": "https://example.pl/index.html",
  "verdict": "match",
  "confidence": 0.92,
  "path": "fast",
  "reasoning": "Page title 'Maraton Warszawski 2026' and H1 match the event name and year exactly.",
  "evidence": {
    "title": "...",
    "meta_description": "...",
    "h1": ["..."],
    "body_sample": "... first 500 chars ..."
  },
  "checked_at": "2026-04-20T14:32:10Z"
}
```

**Verdict enum**: `match`, `mismatch`, `uncertain`, `skipped_social`, `skipped_dead`, `error`.
**Path enum**: `fast`, `full`, `none` (for skip/error cases).

Errors during fetch, parse, or LLM call → `verdict: error` with the exception message in `reasoning`, so one bad event never aborts the run.

## Report file

- Path: `enricher/logs/audit-<YYYYMMDDTHHMMSS>.jsonl`
- Format: one JSON object per line (JSONL), UTF-8.
- Designed to be trivially readable by Claude or another script: `cat audit-*.jsonl | jq 'select(.verdict == "mismatch")'`.

### Stdout summary

After the run, print a concise summary:

```
=== Audit done ===
events checked: 412
verdicts:
  match:          337
  mismatch:        18
  uncertain:       29
  skipped_social:  22
  skipped_dead:     4
  error:            2
report: enricher/logs/audit-20260420T143210.jsonl

top 10 mismatches:
  [0.94] Maraton Krakowski / https://old-race-site.pl — title mentions "2024"
  ...
```

## Publish/sync protection (required by user)

The audit itself writes nothing. However, once the user consumes the report and nulls a bad URL on `calendar_events`, the next publish/sync run must not resurrect the bad value.

### Schema change

Add to `calendar_events` (Supabase-only table, applied via `mcp__supabase__apply_migration`):

```sql
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS locked_fields text[] NOT NULL DEFAULT '{}';
```

Semantics: if a column name appears in `locked_fields`, no automated writer may overwrite it. Human admin edits can still modify the field directly.

### Write paths that must respect `locked_fields`

1. `backend/scripts/run-publish.js` (scraper_all → calendar_events). For each row being upserted, read the existing `locked_fields` and strip those keys from the update payload before writing.
2. `enricher/enricher/sync.py` (enricher sync → calendar_events). Same rule: skip locked fields in the update payload.
3. Admin edit endpoint in `backend/src/routes/calendar-events.js`: when an admin PATCHes a field, append that field name to `locked_fields` (deduped). This means a human correction is sticky. The endpoint also supports explicit `locked_fields` updates so locks can be cleared if needed.

### Unlocking

Two ways to remove a lock:
- Admin UI exposes the `locked_fields` array as an editable control (future UI work — not part of this spec).
- A one-off script or direct Supabase SQL: `UPDATE calendar_events SET locked_fields = array_remove(locked_fields, 'website') WHERE id = '...'`.

### Interaction with the audit

The audit does not touch `locked_fields`. The follow-up action (nulling via a future tool or manual SQL) is what sets the lock. Design leaves that door open without prescribing it.

## Code layout

```
enricher/enricher/
  __main__.py            # add `audit` command
  audit.py               # new — orchestrates the audit run
  steps/
    audit_fetch.py       # new — fast-path HTTP + HTML parse helpers
    audit_prompt.py      # new — prompt builders (fast and full)
    audit_verdict.py     # new — LLM call + JSON parse + verdict schema
```

Shared with existing code:
- `enricher.config.load_config`
- `enricher.steps.crawl.crawl_pages` (for full-path fallback)
- `enricher.steps.llm.call_ollama`
- `enricher.steps.validate_urls` (for dead-URL detection — reused, not re-implemented)
- Social-host set from `enricher.steps.navigate` (refactored to a shared constant if needed)

Client/DB code is isolated in `audit.py` (fetch events from `calendar_events`, not `scraper_all` — this is the only place the new command talks to a different table than the existing pipeline).

## Testing

- Unit: prompt builders produce stable JSON-safe prompts; verdict parser handles malformed LLM output without crashing.
- Integration: a small fixture set of Polish running sites (match, mismatch, SPA, Facebook, dead) producing expected verdicts against the real Ollama model, run manually once to validate before first real audit.
- Smoke: `python -m enricher audit --limit 3` on real data completes and writes a non-empty report.

## Migration steps (for the plan that follows)

1. Supabase migration: add `locked_fields text[]` to `calendar_events`.
2. Update `run-publish.js` and `sync.py` to respect `locked_fields`.
3. Update admin PATCH endpoint to append edited fields to `locked_fields`.
4. Implement `enricher/enricher/audit.py` + supporting step modules.
5. Wire `audit` subcommand in `__main__.py`.
6. Document the command in `enricher/README.md` and the scraper pipeline section of `CLAUDE.md`.
