# Enricher Website Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `audit` subcommand to the Python enricher that reviews `website` URLs on future `calendar_events` using a hybrid fast-path + full-crawl LLM analysis, writing a JSONL report but never mutating the database — and make the existing publish/sync paths respect manually-corrected fields via a new `locked_fields` column.

**Architecture:** New `audit.py` orchestrator in the enricher package plus three new step modules (`audit_fetch`, `audit_prompt`, `audit_verdict`). Hybrid flow per URL: skip-check (social/dead) → fast HTTP fetch + minimal HTML parse → LLM verdict → fall back to Crawl4AI full crawl only if fast path is low-confidence, uncertain, or content is thin. Report written to `enricher/logs/audit-<ts>.jsonl`. A separate `locked_fields text[]` column on `calendar_events` is respected by `enricher/enricher/sync.py`; the admin PATCH endpoint auto-appends edited field names to `locked_fields` so human corrections become sticky. `publishToCalendar` is insert-only and needs no change.

**Tech Stack:** Python 3.10+, Click (CLI), httpx (fast-path HTTP), BeautifulSoup 4 (HTML parse), Crawl4AI (fallback), Ollama (gemma3:27b), supabase-py, pytest + respx for tests. On the backend side: Fastify + Supabase JS client.

---

## File Structure

**New files:**
- `enricher/enricher/audit.py` — top-level command: fetches events, iterates, writes JSONL.
- `enricher/enricher/steps/audit_fetch.py` — fast-path HTTP fetch + HTML field extractor (title/meta/h1/body sample).
- `enricher/enricher/steps/audit_prompt.py` — prompt builders for fast and full paths.
- `enricher/enricher/steps/audit_verdict.py` — `AuditVerdict` dataclass + LLM call wrapper + JSON parser.
- `enricher/tests/test_audit_fetch.py` — unit tests for HTML parsing.
- `enricher/tests/test_audit_prompt.py` — unit tests for prompt builders.
- `enricher/tests/test_audit_verdict.py` — unit tests for the verdict parser.
- `enricher/tests/test_audit.py` — unit tests for the orchestrator (process_url, write_report line shape).

**Modified files:**
- `enricher/enricher/__main__.py` — add `audit` subcommand.
- `enricher/enricher/sync.py` — strip locked fields from update payload.
- `enricher/enricher/steps/navigate.py` — expose `SOCIAL_HOSTS` constant (subset of `JUNK_EXTERNAL_HOSTS`) used by audit_fetch.
- `enricher/pyproject.toml` — add `beautifulsoup4>=4.12.0`.
- `enricher/README.md` — document the new `audit` command and locked_fields semantics.
- `backend/src/routes/calendarEvents.js` — PATCH appends edited field names to `locked_fields`.
- `CLAUDE.md` — two-line update in the enricher section referencing the new command and locked_fields guard.

**Supabase (DB, no local file):**
- Migration adding `calendar_events.locked_fields text[] NOT NULL DEFAULT '{}'`.

---

### Task 1: Supabase schema — add `locked_fields`

**Files:**
- Supabase-only: apply via `mcp__supabase__apply_migration`.

- [ ] **Step 1: Confirm the migration name and SQL**

Migration name: `add_locked_fields_to_calendar_events`.

SQL:
```sql
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS locked_fields text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN calendar_events.locked_fields IS
  'Array of column names whose value must not be overwritten by automated writers (enricher sync, future publish-merge paths). Admin UI edits append to this. Human admins may clear entries directly.';
```

- [ ] **Step 2: Apply migration via MCP**

Use the `mcp__supabase__apply_migration` tool with the name and SQL above. The project ID is configured in the MCP client — do not hardcode it in code.

Before running: state the intent out loud per CLAUDE.md "Database write safety" — schema change, idempotent (`IF NOT EXISTS`), default is empty array so existing rows get `'{}'`. Ask for user confirmation if this is being run by hand; the subagent runner should proceed because the plan itself constitutes the approval.

- [ ] **Step 3: Verify column exists**

Run:
```
mcp__supabase__execute_sql with SQL:
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'calendar_events' AND column_name = 'locked_fields';
```
Expected: one row, `data_type = ARRAY`, default `'{}'::text[]`.

- [ ] **Step 4: Commit**

No files to stage — this is a remote schema change. Record the migration name in the next commit message (Task 9 or Task 10). Proceed to Task 2.

---

### Task 2: Extract social-host constant

**Files:**
- Modify: `enricher/enricher/steps/navigate.py`

- [ ] **Step 1: Write the failing test**

Create `enricher/tests/test_navigate_social_hosts.py`:
```python
from enricher.steps.navigate import SOCIAL_HOSTS, is_social_host


def test_facebook_is_social():
    assert is_social_host("https://www.facebook.com/events/12345") is True


def test_instagram_is_social():
    assert is_social_host("https://instagram.com/biegleszka") is True


def test_fb_short_domain_is_social():
    assert is_social_host("https://fb.com/page") is True


def test_normal_website_is_not_social():
    assert is_social_host("https://biegleszka.pl") is False


def test_none_and_empty_are_not_social():
    assert is_social_host(None) is False
    assert is_social_host("") is False


def test_social_hosts_set_is_populated():
    assert "facebook.com" in SOCIAL_HOSTS
    assert "instagram.com" in SOCIAL_HOSTS
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd enricher && source .venv/bin/activate && pytest tests/test_navigate_social_hosts.py -v`
Expected: ImportError for `SOCIAL_HOSTS`/`is_social_host`.

- [ ] **Step 3: Add the constant and helper to `navigate.py`**

After `JUNK_EXTERNAL_HOSTS` add (keep existing behavior unchanged — `JUNK_EXTERNAL_HOSTS` stays the same, `SOCIAL_HOSTS` is a curated subset):

```python
# Hosts whose pages cannot be meaningfully analyzed by the LLM audit
# (JS-rendered app shells, auth-walled content). Left alone by the audit.
SOCIAL_HOSTS = {
    "facebook.com", "www.facebook.com", "m.facebook.com", "fb.com", "www.fb.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "x.com",
    "tiktok.com", "www.tiktok.com",
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
}


def is_social_host(url: str) -> bool:
    """Return True if the URL's host is a social/media platform that the audit should skip."""
    if not url:
        return False
    try:
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        if not host:
            return False
        return host in SOCIAL_HOSTS or any(
            host.endswith(f".{d}") for d in SOCIAL_HOSTS
        )
    except Exception:
        return False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_navigate_social_hosts.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/navigate.py enricher/tests/test_navigate_social_hosts.py
git commit -m "feat(enricher): add SOCIAL_HOSTS constant and is_social_host helper"
```

---

### Task 3: Fast-path fetch + HTML parse

**Files:**
- Create: `enricher/enricher/steps/audit_fetch.py`
- Create: `enricher/tests/test_audit_fetch.py`
- Modify: `enricher/pyproject.toml`

- [ ] **Step 1: Add `beautifulsoup4` dependency**

Edit `enricher/pyproject.toml`, inside `[project] dependencies` list, add `"beautifulsoup4>=4.12.0",` after `"httpx>=0.27.0",`. Final list:

```toml
dependencies = [
    "crawl4ai>=0.8.0",
    "docling>=2.70.0",
    "httpx>=0.27.0",
    "beautifulsoup4>=4.12.0",
    "supabase>=2.0.0",
    "click>=8.0.0",
    "python-dotenv>=1.0.0",
]
```

Install:
```bash
cd enricher && source .venv/bin/activate && pip install -e .
```

- [ ] **Step 2: Write the failing tests**

Create `enricher/tests/test_audit_fetch.py`:
```python
import httpx
import respx
import pytest
from enricher.steps.audit_fetch import fetch_fast, parse_html, FastPage


def test_parse_html_extracts_title_meta_h1_body():
    html = """
    <html>
      <head>
        <title>Maraton Warszawski 2026</title>
        <meta name="description" content="Najstarszy maraton w Polsce">
      </head>
      <body>
        <h1>Maraton Warszawski</h1>
        <p>Zapraszamy na 48. edycję biegu w Warszawie, 20 kwietnia 2026.</p>
        <p>Dystans: 42.195 km</p>
      </body>
    </html>
    """
    page = parse_html(html, body_chars=500)
    assert page.title == "Maraton Warszawski 2026"
    assert page.meta_description == "Najstarszy maraton w Polsce"
    assert page.h1 == ["Maraton Warszawski"]
    assert "48. edycję" in page.body_sample
    assert len(page.body_sample) <= 500


def test_parse_html_multiple_h1_capped():
    html = "<html><body>" + "".join(f"<h1>H{i}</h1>" for i in range(10)) + "</body></html>"
    page = parse_html(html, body_chars=200)
    assert len(page.h1) <= 5  # cap at 5


def test_parse_html_missing_fields_returns_empty_strings():
    page = parse_html("<html><body>hello</body></html>", body_chars=100)
    assert page.title == ""
    assert page.meta_description == ""
    assert page.h1 == []
    assert page.body_sample == "hello"


def test_parse_html_strips_scripts_and_styles():
    html = """
    <html><body>
      <script>alert('x')</script>
      <style>.a{color:red}</style>
      <p>Real content</p>
    </body></html>
    """
    page = parse_html(html, body_chars=500)
    assert "alert" not in page.body_sample
    assert "color:red" not in page.body_sample
    assert "Real content" in page.body_sample


def test_fetch_fast_success():
    with respx.mock:
        respx.get("https://example.pl").mock(
            return_value=httpx.Response(
                200,
                text="<html><head><title>T</title></head><body><p>body text here</p></body></html>",
                headers={"content-type": "text/html; charset=utf-8"},
            )
        )
        page = fetch_fast("https://example.pl", timeout=5, body_chars=200)
    assert page is not None
    assert page.title == "T"
    assert page.status == "ok"
    assert page.final_url == "https://example.pl"


def test_fetch_fast_404_returns_dead_status():
    with respx.mock:
        respx.get("https://example.pl/gone").mock(return_value=httpx.Response(404))
        page = fetch_fast("https://example.pl/gone", timeout=5, body_chars=200)
    assert page is not None
    assert page.status == "dead"
    assert page.http_status == 404


def test_fetch_fast_timeout_returns_dead_status():
    with respx.mock:
        respx.get("https://slow.pl").mock(side_effect=httpx.TimeoutException("timeout"))
        page = fetch_fast("https://slow.pl", timeout=1, body_chars=200)
    assert page is not None
    assert page.status == "dead"
    assert page.error and "timeout" in page.error.lower()


def test_fetch_fast_non_html_content_type_marks_dead():
    with respx.mock:
        respx.get("https://example.pl/file.pdf").mock(
            return_value=httpx.Response(
                200,
                content=b"%PDF-1.4 binary",
                headers={"content-type": "application/pdf"},
            )
        )
        page = fetch_fast("https://example.pl/file.pdf", timeout=5, body_chars=200)
    assert page.status == "dead"
    assert page.error == "non-html content"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd enricher && pytest tests/test_audit_fetch.py -v`
Expected: ImportError for module / FastPage / fetch_fast / parse_html.

- [ ] **Step 4: Implement `audit_fetch.py`**

Create `enricher/enricher/steps/audit_fetch.py`:
```python
"""Fast-path HTTP fetch and lightweight HTML parsing for the audit command.

Extracts just enough of a page (title, meta description, h1 texts, body sample)
to feed a short LLM prompt. No JS rendering — that is the full-path fallback's
job (Crawl4AI).
"""
from dataclasses import dataclass, field
from typing import Optional

import httpx
from bs4 import BeautifulSoup


# Same headers as validate_urls.py — many Polish CMSes gatekeep on UA.
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pl,en-US;q=0.9,en;q=0.8",
}


@dataclass
class FastPage:
    url: str
    final_url: str = ""
    status: str = "ok"          # "ok" | "dead"
    http_status: int = 0
    title: str = ""
    meta_description: str = ""
    h1: list = field(default_factory=list)
    body_sample: str = ""
    error: Optional[str] = None


def fetch_fast(url: str, timeout: int = 10, body_chars: int = 2000) -> Optional[FastPage]:
    """Fetch a URL via plain HTTP GET and extract a FastPage.

    Returns None only on catastrophic failures that we want to swallow in the
    caller (we don't currently have any — this is future-proofing).
    """
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers=_BROWSER_HEADERS,
        ) as client:
            resp = client.get(url)
    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        return FastPage(url=url, status="dead", error=str(e)[:200])

    if resp.status_code >= 400:
        return FastPage(
            url=url,
            final_url=str(resp.url),
            status="dead",
            http_status=resp.status_code,
            error=f"HTTP {resp.status_code}",
        )

    content_type = resp.headers.get("content-type", "").lower()
    if "html" not in content_type and "xml" not in content_type:
        return FastPage(
            url=url,
            final_url=str(resp.url),
            status="dead",
            http_status=resp.status_code,
            error="non-html content",
        )

    page = parse_html(resp.text, body_chars=body_chars)
    page.url = url
    page.final_url = str(resp.url)
    page.http_status = resp.status_code
    page.status = "ok"
    return page


def parse_html(html: str, body_chars: int = 2000) -> FastPage:
    """Parse HTML into a FastPage (no network I/O)."""
    soup = BeautifulSoup(html or "", "html.parser")

    # Strip noise
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()

    h1_tags = soup.find_all("h1", limit=5)
    h1_texts = [t.get_text(" ", strip=True) for t in h1_tags if t.get_text(strip=True)]

    # Body sample: visible text of body, whitespace-collapsed, truncated
    body_root = soup.body or soup
    body_text = body_root.get_text(" ", strip=True)
    # Collapse runs of whitespace
    body_text = " ".join(body_text.split())
    body_sample = body_text[:body_chars]

    return FastPage(
        url="",
        title=title,
        meta_description=meta_desc,
        h1=h1_texts,
        body_sample=body_sample,
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_audit_fetch.py -v`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add enricher/enricher/steps/audit_fetch.py enricher/tests/test_audit_fetch.py enricher/pyproject.toml
git commit -m "feat(enricher): add fast-path HTTP fetch and HTML parser for audit"
```

---

### Task 4: Audit prompt builders

**Files:**
- Create: `enricher/enricher/steps/audit_prompt.py`
- Create: `enricher/tests/test_audit_prompt.py`

- [ ] **Step 1: Write the failing tests**

Create `enricher/tests/test_audit_prompt.py`:
```python
from enricher.steps.audit_fetch import FastPage
from enricher.steps.audit_prompt import build_fast_prompt, build_full_prompt


def _sample_event():
    return {
        "id": "uuid-1",
        "name": "Bieg Leszka",
        "date": "2026-05-10",
        "location": "Warszawa",
        "voivodeship": "Mazowieckie",
        "distances": ["5 km", "10 km"],
    }


def test_fast_prompt_includes_event_facts():
    page = FastPage(
        url="https://x.pl",
        title="Bieg Leszka 2026",
        meta_description="Bieg w Warszawie",
        h1=["Bieg Leszka"],
        body_sample="Maj 2026, 5km i 10km",
    )
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "Bieg Leszka" in prompt
    assert "2026-05-10" in prompt
    assert "Warszawa" in prompt
    assert "Mazowieckie" in prompt
    assert "5 km" in prompt
    assert "10 km" in prompt


def test_fast_prompt_includes_page_content():
    page = FastPage(
        url="https://x.pl",
        title="My Title",
        meta_description="My Meta",
        h1=["H1a", "H1b"],
        body_sample="Body text here",
    )
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "My Title" in prompt
    assert "My Meta" in prompt
    assert "H1a" in prompt
    assert "H1b" in prompt
    assert "Body text here" in prompt


def test_fast_prompt_requests_specific_json_shape():
    page = FastPage(url="https://x.pl")
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "verdict" in prompt
    assert "confidence" in prompt
    assert "reasoning" in prompt
    # All three allowed verdict values must be named
    assert "match" in prompt
    assert "mismatch" in prompt
    assert "uncertain" in prompt


def test_fast_prompt_labels_which_field_is_being_audited():
    page = FastPage(url="https://x.pl")
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "website" in prompt


def test_fast_prompt_handles_missing_event_fields():
    event = {"id": "x", "name": "Event", "date": "2026-05-10"}
    page = FastPage(url="https://x.pl")
    prompt = build_fast_prompt(event, "website", "https://x.pl", page)
    # Must not raise; fallback text like "unknown" acceptable
    assert "Event" in prompt


def test_full_prompt_uses_crawled_content():
    event = _sample_event()
    prompt = build_full_prompt(
        event,
        "website",
        "https://x.pl",
        crawled_content="Bieg Leszka 10 maja 2026 w Warszawie. 5 km i 10 km.",
        max_content_chars=5000,
    )
    assert "Bieg Leszka 10 maja 2026" in prompt
    assert "verdict" in prompt
    assert "website" in prompt


def test_full_prompt_truncates_long_content():
    event = _sample_event()
    long_text = "x" * 20000
    prompt = build_full_prompt(
        event, "website", "https://x.pl",
        crawled_content=long_text, max_content_chars=5000,
    )
    # The prompt must NOT contain the full 20k chars — only truncated
    assert prompt.count("x") <= 5000 + 100  # small slack for label text containing 'x'


def test_full_prompt_requests_json_shape():
    prompt = build_full_prompt(
        _sample_event(), "website", "https://x.pl",
        crawled_content="some content", max_content_chars=5000,
    )
    assert "match" in prompt
    assert "mismatch" in prompt
    assert "uncertain" in prompt
    assert "confidence" in prompt
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd enricher && pytest tests/test_audit_prompt.py -v`
Expected: ImportError on `audit_prompt`.

- [ ] **Step 3: Implement `audit_prompt.py`**

Create `enricher/enricher/steps/audit_prompt.py`:
```python
"""Prompts for the website audit.

Fast prompt: tiny, based on FastPage (title, meta, h1, 2KB body).
Full prompt: longer, based on crawled markdown content from Crawl4AI.

Both ask the LLM to return identical JSON shape so the caller parses one way.
"""
from typing import Optional

from enricher.steps.audit_fetch import FastPage


JSON_INSTRUCTIONS = """Return ONLY valid JSON, no prose, no code fences. Shape:
{
  "verdict": "match" | "mismatch" | "uncertain",
  "confidence": 0.0 to 1.0,
  "reasoning": "one to three short sentences in English explaining the decision, citing concrete evidence (event name on page, year in title, city in body, distances, etc.)"
}

Use "match" when the page is clearly about this specific event (same name or close variant, same year, same city).
Use "mismatch" when the page is clearly about a different event, a past edition of the same name, a news article, an aggregator listing, or is unrelated.
Use "uncertain" only if you genuinely cannot tell from the provided content."""


def _fmt_distances(d) -> str:
    if not d:
        return "unknown"
    if isinstance(d, list):
        return ", ".join(str(x) for x in d)
    return str(d)


def _fmt_val(v, default: str = "unknown") -> str:
    if v is None or v == "":
        return default
    return str(v)


def build_fast_prompt(event: dict, field: str, url: str, page: FastPage) -> str:
    """Build the lean fast-path prompt from extracted HTML fragments."""
    h1_joined = " | ".join(page.h1) if page.h1 else "(none)"
    return f"""You are auditing whether a webpage actually belongs to a specific Polish running/walking event.

EVENT:
  name: {_fmt_val(event.get("name"))}
  date: {_fmt_val(event.get("date"))}
  city: {_fmt_val(event.get("location"))}
  voivodeship: {_fmt_val(event.get("voivodeship"))}
  known distances: {_fmt_distances(event.get("distances"))}

FIELD UNDER AUDIT: {field}
URL: {url}

PAGE (extracted from HTML):
  <title>: {_fmt_val(page.title, "(empty)")}
  <meta description>: {_fmt_val(page.meta_description, "(empty)")}
  <h1>: {h1_joined}
  body sample: {_fmt_val(page.body_sample, "(empty)")}

{JSON_INSTRUCTIONS}"""


def build_full_prompt(
    event: dict,
    field: str,
    url: str,
    crawled_content: str,
    max_content_chars: int,
) -> str:
    """Build the full-path prompt using Crawl4AI markdown content."""
    content = (crawled_content or "")[:max_content_chars]
    if not content.strip():
        content = "(page appeared empty after rendering)"
    return f"""You are auditing whether a webpage actually belongs to a specific Polish running/walking event.

EVENT:
  name: {_fmt_val(event.get("name"))}
  date: {_fmt_val(event.get("date"))}
  city: {_fmt_val(event.get("location"))}
  voivodeship: {_fmt_val(event.get("voivodeship"))}
  known distances: {_fmt_distances(event.get("distances"))}

FIELD UNDER AUDIT: {field}
URL: {url}

PAGE CONTENT (rendered with JavaScript, up to {max_content_chars} chars):
{content}

{JSON_INSTRUCTIONS}"""
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_audit_prompt.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/audit_prompt.py enricher/tests/test_audit_prompt.py
git commit -m "feat(enricher): add audit prompt builders for fast and full paths"
```

---

### Task 5: Audit verdict dataclass + LLM call

**Files:**
- Create: `enricher/enricher/steps/audit_verdict.py`
- Create: `enricher/tests/test_audit_verdict.py`

- [ ] **Step 1: Write the failing tests**

Create `enricher/tests/test_audit_verdict.py`:
```python
from enricher.steps.audit_verdict import AuditVerdict, parse_verdict


def test_parse_verdict_clean_json():
    raw = '{"verdict":"match","confidence":0.9,"reasoning":"Title matches"}'
    v = parse_verdict(raw)
    assert v is not None
    assert v.verdict == "match"
    assert v.confidence == 0.9
    assert "Title" in v.reasoning


def test_parse_verdict_with_code_fences():
    raw = '```json\n{"verdict":"mismatch","confidence":0.82,"reasoning":"Different year"}\n```'
    v = parse_verdict(raw)
    assert v.verdict == "mismatch"
    assert abs(v.confidence - 0.82) < 1e-6


def test_parse_verdict_with_leading_prose():
    raw = 'Sure. Here is the JSON:\n{"verdict":"uncertain","confidence":0.3,"reasoning":"Thin content"}'
    v = parse_verdict(raw)
    assert v.verdict == "uncertain"


def test_parse_verdict_invalid_verdict_value_rejected():
    raw = '{"verdict":"great","confidence":1.0,"reasoning":"n/a"}'
    v = parse_verdict(raw)
    assert v is None


def test_parse_verdict_confidence_clamped():
    raw = '{"verdict":"match","confidence":1.5,"reasoning":"n/a"}'
    v = parse_verdict(raw)
    assert v is not None
    assert v.confidence == 1.0

    raw2 = '{"verdict":"match","confidence":-0.2,"reasoning":"n/a"}'
    v2 = parse_verdict(raw2)
    assert v2.confidence == 0.0


def test_parse_verdict_malformed_json_returns_none():
    assert parse_verdict("not json at all") is None
    assert parse_verdict("") is None
    assert parse_verdict(None) is None


def test_parse_verdict_missing_required_fields_returns_none():
    assert parse_verdict('{"verdict":"match"}') is None
    assert parse_verdict('{"confidence":0.5,"reasoning":"x"}') is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd enricher && pytest tests/test_audit_verdict.py -v`
Expected: ImportError on `audit_verdict`.

- [ ] **Step 3: Implement `audit_verdict.py`**

Create `enricher/enricher/steps/audit_verdict.py`:
```python
"""AuditVerdict dataclass and LLM call wrapper for the audit command."""
import json
import re
import time
from dataclasses import dataclass
from typing import Optional

import httpx


ALLOWED_VERDICTS = {"match", "mismatch", "uncertain"}


@dataclass
class AuditVerdict:
    verdict: str           # "match" | "mismatch" | "uncertain"
    confidence: float      # 0.0..1.0
    reasoning: str
    duration_s: float = 0.0


def parse_verdict(raw: Optional[str]) -> Optional[AuditVerdict]:
    """Extract a verdict from raw LLM text. Returns None on any failure."""
    if not raw:
        return None

    cleaned = re.sub(r"```json\s*", "", raw)
    cleaned = re.sub(r"```\s*", "", cleaned)
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None

    verdict = obj.get("verdict")
    confidence = obj.get("confidence")
    reasoning = obj.get("reasoning")
    if verdict not in ALLOWED_VERDICTS:
        return None
    if not isinstance(confidence, (int, float)):
        return None
    if not isinstance(reasoning, str):
        return None

    # Clamp confidence to [0, 1]
    conf = float(confidence)
    if conf > 1.0:
        conf = 1.0
    if conf < 0.0:
        conf = 0.0

    return AuditVerdict(verdict=verdict, confidence=conf, reasoning=reasoning)


def call_audit_llm(prompt: str, config) -> Optional[AuditVerdict]:
    """Call Ollama for an audit verdict. Returns None on any error."""
    start = time.time()
    try:
        with httpx.Client(timeout=600) as client:
            resp = client.post(
                f"{config.ollama_url}/api/generate",
                json={
                    "model": config.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": config.ollama_temperature,
                        "num_predict": config.ollama_max_tokens,
                        "num_ctx": 32768,
                    },
                },
            )
            resp.raise_for_status()
        data = resp.json()
        raw = data.get("response", "")
        verdict = parse_verdict(raw)
        if verdict:
            verdict.duration_s = round(time.time() - start, 1)
        return verdict
    except Exception:
        return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_audit_verdict.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/audit_verdict.py enricher/tests/test_audit_verdict.py
git commit -m "feat(enricher): add AuditVerdict dataclass and LLM call wrapper"
```

---

### Task 6: Audit orchestrator — `process_url`

**Files:**
- Create: `enricher/enricher/audit.py`
- Create: `enricher/tests/test_audit.py`

- [ ] **Step 1: Write the failing tests**

Create `enricher/tests/test_audit.py`:
```python
import asyncio
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock, MagicMock
from enricher.audit import process_url, AuditReportLine


def _cfg():
    return SimpleNamespace(
        ollama_url="http://localhost:11434",
        ollama_model="gemma3:27b",
        ollama_temperature=0.1,
        ollama_max_tokens=1024,
        url_timeout=5,
        max_page_chars=5000,
    )


def _event():
    return {
        "id": "uuid-1",
        "name": "Bieg Leszka",
        "date": "2026-05-10",
        "location": "Warszawa",
        "voivodeship": "Mazowieckie",
        "distances": ["5 km"],
    }


def test_process_url_skips_facebook():
    line = asyncio.run(process_url(
        event=_event(),
        field="website",
        url="https://www.facebook.com/biegleszka",
        config=_cfg(),
        confidence_threshold=0.8,
    ))
    assert line.verdict == "skipped_social"
    assert line.path == "none"
    assert line.url == "https://www.facebook.com/biegleszka"


def test_process_url_fast_path_high_confidence_no_fallback():
    from enricher.steps.audit_fetch import FastPage
    from enricher.steps.audit_verdict import AuditVerdict

    page = FastPage(
        url="https://x.pl", final_url="https://x.pl", status="ok", http_status=200,
        title="Bieg Leszka 2026", meta_description="", h1=["Bieg Leszka"],
        body_sample="x" * 600,  # over 500 char threshold
    )
    verdict = AuditVerdict(verdict="match", confidence=0.95, reasoning="Title matches")

    with patch("enricher.audit.fetch_fast", return_value=page), \
         patch("enricher.audit.call_audit_llm", return_value=verdict) as llm, \
         patch("enricher.audit.crawl_pages", new=AsyncMock()) as crawl:
        line = asyncio.run(process_url(
            event=_event(), field="website", url="https://x.pl",
            config=_cfg(), confidence_threshold=0.8,
        ))

    assert line.verdict == "match"
    assert line.path == "fast"
    assert line.confidence == 0.95
    assert llm.call_count == 1
    crawl.assert_not_called()


def test_process_url_fast_path_low_confidence_falls_back_to_full():
    from enricher.steps.audit_fetch import FastPage
    from enricher.steps.audit_verdict import AuditVerdict
    from enricher.steps.crawl import CrawlResult

    page = FastPage(
        url="https://x.pl", final_url="https://x.pl", status="ok", http_status=200,
        title="Some Title", meta_description="", h1=[],
        body_sample="x" * 600,
    )
    fast_verdict = AuditVerdict(verdict="uncertain", confidence=0.5, reasoning="Thin")
    full_verdict = AuditVerdict(verdict="match", confidence=0.9, reasoning="Full crawl confirms")
    crawl_result = {"url": CrawlResult(url="https://x.pl", content="rich content", chars=12)}

    with patch("enricher.audit.fetch_fast", return_value=page), \
         patch("enricher.audit.call_audit_llm", side_effect=[fast_verdict, full_verdict]) as llm, \
         patch("enricher.audit.crawl_pages", new=AsyncMock(return_value=crawl_result)):
        line = asyncio.run(process_url(
            event=_event(), field="website", url="https://x.pl",
            config=_cfg(), confidence_threshold=0.8,
        ))

    assert line.verdict == "match"
    assert line.path == "full"
    assert line.confidence == 0.9
    assert llm.call_count == 2


def test_process_url_thin_content_triggers_fallback():
    from enricher.steps.audit_fetch import FastPage
    from enricher.steps.audit_verdict import AuditVerdict
    from enricher.steps.crawl import CrawlResult

    page = FastPage(
        url="https://x.pl", final_url="https://x.pl", status="ok", http_status=200,
        title="Hi", meta_description="", h1=[], body_sample="short",  # under thresholds
    )
    full_verdict = AuditVerdict(verdict="mismatch", confidence=0.88, reasoning="Wrong year")
    crawl_result = {"url": CrawlResult(url="https://x.pl", content="real content here", chars=17)}

    with patch("enricher.audit.fetch_fast", return_value=page), \
         patch("enricher.audit.call_audit_llm", return_value=full_verdict) as llm, \
         patch("enricher.audit.crawl_pages", new=AsyncMock(return_value=crawl_result)):
        line = asyncio.run(process_url(
            event=_event(), field="website", url="https://x.pl",
            config=_cfg(), confidence_threshold=0.8,
        ))

    assert line.path == "full"
    # Thin content → fast path is skipped entirely, so only the full path LLM call runs
    assert llm.call_count == 1
    assert line.verdict == "mismatch"


def test_process_url_dead_url_short_circuits():
    from enricher.steps.audit_fetch import FastPage
    dead = FastPage(url="https://x.pl", status="dead", http_status=404, error="HTTP 404")
    with patch("enricher.audit.fetch_fast", return_value=dead), \
         patch("enricher.audit.call_audit_llm") as llm, \
         patch("enricher.audit.crawl_pages", new=AsyncMock()) as crawl:
        line = asyncio.run(process_url(
            event=_event(), field="website", url="https://x.pl",
            config=_cfg(), confidence_threshold=0.8,
        ))
    assert line.verdict == "skipped_dead"
    assert line.path == "none"
    llm.assert_not_called()
    crawl.assert_not_called()


def test_process_url_llm_failure_reports_error():
    from enricher.steps.audit_fetch import FastPage
    page = FastPage(
        url="https://x.pl", status="ok", http_status=200,
        title="Real Title", h1=[], body_sample="x" * 600,
    )
    with patch("enricher.audit.fetch_fast", return_value=page), \
         patch("enricher.audit.call_audit_llm", return_value=None), \
         patch("enricher.audit.crawl_pages", new=AsyncMock(return_value={"url": None})):
        line = asyncio.run(process_url(
            event=_event(), field="website", url="https://x.pl",
            config=_cfg(), confidence_threshold=0.8,
        ))
    assert line.verdict == "error"


def test_audit_report_line_to_json_shape_is_stable():
    from enricher.audit import AuditReportLine
    line = AuditReportLine(
        event_id="uuid-1", event_name="Bieg", event_date="2026-05-10",
        event_location="Warszawa", event_voivodeship="Mazowieckie",
        field="website", url="https://x.pl", final_url="https://x.pl",
        verdict="match", confidence=0.9, path="fast",
        reasoning="Matches", evidence={"title": "Bieg 2026"},
        checked_at="2026-04-20T10:00:00+00:00",
    )
    j = line.to_json()
    assert j["event_id"] == "uuid-1"
    assert j["verdict"] == "match"
    assert j["confidence"] == 0.9
    assert j["path"] == "fast"
    assert j["evidence"]["title"] == "Bieg 2026"
    # Stable key set — downstream AI needs predictable shape
    assert set(j.keys()) == {
        "event_id", "event_name", "event_date", "event_location", "event_voivodeship",
        "field", "url", "final_url", "verdict", "confidence", "path",
        "reasoning", "evidence", "checked_at",
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd enricher && pytest tests/test_audit.py -v`
Expected: ImportError on `enricher.audit`.

- [ ] **Step 3: Implement `audit.py`** — just `process_url` + `AuditReportLine` for now

Create `enricher/enricher/audit.py`:
```python
"""Audit command: review website URLs on calendar_events for correctness.

Read-only against the DB. Writes a JSONL report to enricher/logs/audit-<ts>.jsonl.
"""
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from typing import Optional

from enricher.steps.audit_fetch import fetch_fast, FastPage
from enricher.steps.audit_prompt import build_fast_prompt, build_full_prompt
from enricher.steps.audit_verdict import call_audit_llm, AuditVerdict
from enricher.steps.crawl import crawl_pages
from enricher.steps.navigate import is_social_host


FAST_PATH_MIN_TITLE_CHARS = 10
FAST_PATH_MIN_BODY_CHARS = 500
FAST_PATH_BODY_SAMPLE_CHARS = 2000


@dataclass
class AuditReportLine:
    event_id: str
    event_name: str
    event_date: str
    event_location: str
    event_voivodeship: str
    field: str
    url: str
    final_url: str
    verdict: str          # match | mismatch | uncertain | skipped_social | skipped_dead | error
    confidence: float
    path: str             # fast | full | none
    reasoning: str
    evidence: dict
    checked_at: str

    def to_json(self) -> dict:
        return asdict(self)


def _make_line(
    event: dict, field: str, url: str, *,
    verdict: str, confidence: float, path: str,
    reasoning: str, evidence: dict, final_url: str = "",
) -> AuditReportLine:
    return AuditReportLine(
        event_id=event.get("id", ""),
        event_name=event.get("name", ""),
        event_date=str(event.get("date", "")),
        event_location=event.get("location", "") or "",
        event_voivodeship=event.get("voivodeship", "") or "",
        field=field,
        url=url,
        final_url=final_url or url,
        verdict=verdict,
        confidence=confidence,
        path=path,
        reasoning=reasoning,
        evidence=evidence,
        checked_at=datetime.now(timezone.utc).isoformat(),
    )


def _fast_content_is_thin(page: FastPage) -> bool:
    return (
        len(page.title or "") < FAST_PATH_MIN_TITLE_CHARS
        or len(page.body_sample or "") < FAST_PATH_MIN_BODY_CHARS
    )


def _fast_evidence(page: FastPage) -> dict:
    return {
        "title": page.title,
        "meta_description": page.meta_description,
        "h1": page.h1,
        "body_sample": page.body_sample[:500] if page.body_sample else "",
    }


async def process_url(
    event: dict, field: str, url: str, config, confidence_threshold: float = 0.8,
) -> AuditReportLine:
    """Run one audit pass over a single (event, field, url) triple."""
    # 1. Skip social hosts outright
    if is_social_host(url):
        return _make_line(
            event, field, url,
            verdict="skipped_social", confidence=1.0, path="none",
            reasoning="Social/media platform — not analyzable by the audit.",
            evidence={"host": url},
        )

    # 2. Fast path fetch
    page = fetch_fast(url, timeout=config.url_timeout, body_chars=FAST_PATH_BODY_SAMPLE_CHARS)
    if page is None or page.status == "dead":
        return _make_line(
            event, field, url,
            verdict="skipped_dead", confidence=1.0, path="none",
            reasoning=f"URL is not reachable: {page.error if page else 'unknown error'}",
            evidence={"http_status": page.http_status if page else 0, "error": page.error if page else ""},
            final_url=(page.final_url if page else ""),
        )

    # 3. Decide whether to even try the fast path
    trust_fast = not _fast_content_is_thin(page)

    fast_verdict: Optional[AuditVerdict] = None
    if trust_fast:
        prompt = build_fast_prompt(event, field, url, page)
        fast_verdict = call_audit_llm(prompt, config)
        if (
            fast_verdict is not None
            and fast_verdict.verdict != "uncertain"
            and fast_verdict.confidence >= confidence_threshold
        ):
            return _make_line(
                event, field, url,
                verdict=fast_verdict.verdict,
                confidence=fast_verdict.confidence,
                path="fast",
                reasoning=fast_verdict.reasoning,
                evidence=_fast_evidence(page),
                final_url=page.final_url,
            )

    # 4. Full path fallback: Crawl4AI
    crawl_map = await crawl_pages({"url": url}, max_chars=config.max_page_chars)
    crawl_result = crawl_map.get("url") if crawl_map else None
    crawled_content = crawl_result.content if crawl_result else ""

    full_prompt = build_full_prompt(
        event, field, url, crawled_content=crawled_content,
        max_content_chars=config.max_page_chars,
    )
    full_verdict = call_audit_llm(full_prompt, config)

    if full_verdict is None:
        return _make_line(
            event, field, url,
            verdict="error", confidence=0.0, path="full",
            reasoning="LLM call failed or returned unparseable JSON.",
            evidence=_fast_evidence(page),
            final_url=page.final_url,
        )

    return _make_line(
        event, field, url,
        verdict=full_verdict.verdict,
        confidence=full_verdict.confidence,
        path="full",
        reasoning=full_verdict.reasoning,
        evidence={
            **_fast_evidence(page),
            "crawled_chars": len(crawled_content or ""),
        },
        final_url=page.final_url,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_audit.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/audit.py enricher/tests/test_audit.py
git commit -m "feat(enricher): add audit orchestrator with hybrid fast/full path"
```

---

### Task 7: Audit event loop + report writer

**Files:**
- Modify: `enricher/enricher/audit.py` (add `run_audit`, `fetch_audit_events`, `write_report_line`, summary printing)
- Modify: `enricher/tests/test_audit.py` (add tests for report writer + event fetch filtering)

- [ ] **Step 1: Write the failing tests**

Append to `enricher/tests/test_audit.py`:
```python
import json
import os
import tempfile
from enricher.audit import write_report_line, open_report, summarize_verdicts


def test_write_report_line_produces_valid_jsonl():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "audit.jsonl")
        with open_report(path) as f:
            line = AuditReportLine(
                event_id="1", event_name="E", event_date="2026-05-10",
                event_location="W", event_voivodeship="M", field="website",
                url="https://x.pl", final_url="https://x.pl",
                verdict="match", confidence=0.9, path="fast",
                reasoning="ok", evidence={},
                checked_at="2026-04-20T10:00:00+00:00",
            )
            write_report_line(f, line)
            line2 = AuditReportLine(
                event_id="2", event_name="E2", event_date="2026-05-11",
                event_location="K", event_voivodeship="M", field="website",
                url="https://y.pl", final_url="https://y.pl",
                verdict="mismatch", confidence=0.85, path="full",
                reasoning="different year", evidence={},
                checked_at="2026-04-20T10:00:05+00:00",
            )
            write_report_line(f, line2)
        with open(path) as f:
            lines = f.readlines()
        assert len(lines) == 2
        obj1 = json.loads(lines[0])
        obj2 = json.loads(lines[1])
        assert obj1["verdict"] == "match"
        assert obj2["verdict"] == "mismatch"


def test_summarize_verdicts_counts_all_categories():
    verdicts = ["match", "match", "mismatch", "uncertain", "skipped_social", "skipped_dead", "error", "match"]
    counts = summarize_verdicts(verdicts)
    assert counts["match"] == 3
    assert counts["mismatch"] == 1
    assert counts["uncertain"] == 1
    assert counts["skipped_social"] == 1
    assert counts["skipped_dead"] == 1
    assert counts["error"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd enricher && pytest tests/test_audit.py -v -k "report or summarize"`
Expected: ImportError on `write_report_line` / `open_report` / `summarize_verdicts`.

- [ ] **Step 3: Extend `audit.py` with the event loop, report IO, and summary**

Append to `enricher/enricher/audit.py`:
```python
import json as _json
import os
from collections import Counter
from datetime import timedelta
from typing import Iterable, Optional

import click
from supabase import create_client

from enricher.config import Config


def open_report(path: str):
    """Open a JSONL report file for writing. Ensures parent dir exists."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    return open(path, "w", encoding="utf-8")


def write_report_line(f, line: AuditReportLine) -> None:
    f.write(_json.dumps(line.to_json(), ensure_ascii=False) + "\n")
    f.flush()


def summarize_verdicts(verdicts: Iterable[str]) -> dict:
    c = Counter(verdicts)
    return {
        "match": c.get("match", 0),
        "mismatch": c.get("mismatch", 0),
        "uncertain": c.get("uncertain", 0),
        "skipped_social": c.get("skipped_social", 0),
        "skipped_dead": c.get("skipped_dead", 0),
        "error": c.get("error", 0),
    }


def _parse_since(since: Optional[str]) -> str:
    now = datetime.now(timezone.utc)
    if not since or since == "today":
        return now.strftime("%Y-%m-%d")
    if since == "tomorrow":
        return (now + timedelta(days=1)).strftime("%Y-%m-%d")
    # Accept YYYY-MM-DD directly
    try:
        datetime.fromisoformat(since)
        return since
    except ValueError:
        raise click.UsageError(f"--since must be 'today', 'tomorrow', or YYYY-MM-DD, got {since!r}")


def fetch_audit_events(config: Config, since: str, fields: list[str]) -> list[dict]:
    """Fetch future calendar_events rows that have at least one of `fields` populated."""
    sb = create_client(config.supabase_url, config.supabase_key)

    all_rows: list[dict] = []
    page_size = 1000
    offset = 0
    select_cols = "id, name, date, location, voivodeship, distances, event_type, status, website, registration_url, regulamin_url, locked_fields"
    while True:
        data = (
            sb.from_("calendar_events")
            .select(select_cols)
            .gte("date", since)
            .neq("status", "rejected")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        if not data.data:
            break
        all_rows.extend(data.data)
        if len(data.data) < page_size:
            break
        offset += page_size

    # Client-side filter: at least one of `fields` is non-empty
    kept = []
    for r in all_rows:
        for f in fields:
            v = r.get(f)
            if v:
                kept.append(r)
                break
    return kept


async def run_audit(
    config: Config,
    since: str,
    fields: list[str],
    limit: Optional[int],
    confidence_threshold: float,
    log_dir: str = "logs",
) -> str:
    """Run the audit over all matching events. Returns report path."""
    events = fetch_audit_events(config, since, fields)
    if limit:
        events = events[:limit]

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    report_path = os.path.join(log_dir, f"audit-{ts}.jsonl")

    click.echo(f"Auditing {len(events)} events for fields={fields} since={since}")
    click.echo(f"Report: {report_path}\n")

    verdicts: list[str] = []
    mismatches: list[tuple[float, AuditReportLine]] = []

    with open_report(report_path) as rf:
        for i, ev in enumerate(events):
            for fname in fields:
                url = ev.get(fname)
                if not url:
                    continue
                click.echo(f"[{i + 1}/{len(events)}] {ev.get('name', '')} | {fname} | {url[:80]}")
                line = await process_url(ev, fname, url, config, confidence_threshold)
                write_report_line(rf, line)
                verdicts.append(line.verdict)
                click.echo(f"    verdict={line.verdict} conf={line.confidence:.2f} path={line.path}")
                if line.verdict == "mismatch":
                    mismatches.append((line.confidence, line))

    counts = summarize_verdicts(verdicts)
    click.echo("\n=== Audit done ===")
    click.echo(f"events checked: {len(events)}")
    click.echo(f"checks performed: {len(verdicts)}")
    click.echo("verdicts:")
    for k, v in counts.items():
        click.echo(f"  {k:<16} {v}")
    click.echo(f"\nreport: {report_path}")

    if mismatches:
        click.echo("\ntop 10 mismatches:")
        mismatches.sort(key=lambda t: -t[0])
        for conf, line in mismatches[:10]:
            click.echo(f"  [{conf:.2f}] {line.event_name} / {line.url}")
            click.echo(f"         {line.reasoning[:160]}")

    return report_path
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_audit.py -v`
Expected: 10 passed (7 from Task 6 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/audit.py enricher/tests/test_audit.py
git commit -m "feat(enricher): add audit event loop, JSONL report writer, and summary"
```

---

### Task 8: Wire `audit` subcommand

**Files:**
- Modify: `enricher/enricher/__main__.py`

- [ ] **Step 1: Add the command**

Edit `enricher/enricher/__main__.py`. After the existing `sync` function definition (around line 44, before `if __name__`), add:

```python
@cli.command()
@click.option("--limit", type=int, default=None, help="Max events to audit")
@click.option("--fields", type=str, default="website",
              help="Comma-separated URL fields to audit (website, registration_url, regulamin_url)")
@click.option("--since", type=str, default="today",
              help="Lower bound on event date (YYYY-MM-DD | 'today' | 'tomorrow')")
@click.option("--confidence-threshold", type=float, default=0.8,
              help="Fast-path confidence below this triggers fallback to full crawl")
def audit(limit, fields, since, confidence_threshold):
    """Audit URL fields on calendar_events for event relevance. Read-only — writes JSONL report only."""
    import asyncio
    from enricher.audit import run_audit, _parse_since

    config = load_config()
    field_list = [f.strip() for f in fields.split(",") if f.strip()]
    allowed = {"website", "registration_url", "regulamin_url"}
    bad = [f for f in field_list if f not in allowed]
    if bad:
        raise click.UsageError(f"--fields may only contain {sorted(allowed)}, got unknown: {bad}")
    since_date = _parse_since(since)
    click.echo(f"Audit ready. Ollama: {config.ollama_url}")
    asyncio.run(run_audit(
        config=config,
        since=since_date,
        fields=field_list,
        limit=limit,
        confidence_threshold=confidence_threshold,
    ))
```

- [ ] **Step 2: Verify the command is visible**

Run: `cd enricher && source .venv/bin/activate && python -m enricher --help`
Expected output contains a line like `audit   Audit URL fields on calendar_events...`.

Run: `python -m enricher audit --help`
Expected: the four flags (`--limit`, `--fields`, `--since`, `--confidence-threshold`) are listed.

- [ ] **Step 3: Reject unknown `--fields` values**

Run: `python -m enricher audit --fields foo,bar`
Expected: UsageError mentioning allowed values. Exit code != 0.

- [ ] **Step 4: Commit**

```bash
git add enricher/enricher/__main__.py
git commit -m "feat(enricher): wire audit subcommand in CLI"
```

---

### Task 9: Enricher sync respects `locked_fields`

**Files:**
- Modify: `enricher/enricher/sync.py`
- Create: `enricher/tests/test_sync_locked_fields.py`

- [ ] **Step 1: Write the failing test**

Create `enricher/tests/test_sync_locked_fields.py`:
```python
from enricher.sync import filter_locked_fields


def test_filter_locked_fields_strips_listed_keys():
    updates = {"website": "https://x.pl", "price_from": 10, "distances": ["5 km"]}
    result = filter_locked_fields(updates, locked=["website"])
    assert "website" not in result
    assert result["price_from"] == 10
    assert result["distances"] == ["5 km"]


def test_filter_locked_fields_empty_lock_is_noop():
    updates = {"website": "https://x.pl", "price_from": 10}
    assert filter_locked_fields(updates, locked=[]) == updates
    assert filter_locked_fields(updates, locked=None) == updates


def test_filter_locked_fields_unknown_lock_entries_ignored():
    updates = {"website": "https://x.pl"}
    # Extra lock entries that don't appear in updates must not error
    assert filter_locked_fields(updates, locked=["foo", "bar"]) == {"website": "https://x.pl"}


def test_filter_locked_fields_preserves_enriched_at():
    # enriched_at must always pass through — the sync needs it as the completion marker
    updates = {"website": "https://x.pl", "enriched_at": "2026-04-20T10:00:00+00:00"}
    result = filter_locked_fields(updates, locked=["website", "enriched_at"])
    assert "website" not in result
    assert result["enriched_at"] == "2026-04-20T10:00:00+00:00"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd enricher && pytest tests/test_sync_locked_fields.py -v`
Expected: ImportError on `filter_locked_fields`.

- [ ] **Step 3: Add `filter_locked_fields` and wire it into `sync_to_calendar`**

Edit `enricher/enricher/sync.py`:

**(a)** Add the helper above `sync_to_calendar`:
```python
def filter_locked_fields(updates: dict, locked) -> dict:
    """Remove keys present in `locked` from `updates`.

    `enriched_at` is always preserved so the sync can still stamp completion.
    """
    if not locked:
        return updates
    locked_set = set(locked or [])
    return {
        k: v for k, v in updates.items()
        if k == "enriched_at" or k not in locked_set
    }
```

**(b)** Extend the `ce_fields` string (declared once, reused by both the primary lookup and the name+date fallback) to include `locked_fields`. Change:
```python
ce_fields = (
    "id, event_type, distances, registration_url, regulamin_url, "
    "registration_deadline, price_from, price_to, website, voivodeship, enriched_at"
)
```
to:
```python
ce_fields = (
    "id, event_type, distances, registration_url, regulamin_url, "
    "registration_deadline, price_from, price_to, website, voivodeship, enriched_at, locked_fields"
)
```

**(c)** After the `updates` dict is fully assembled and before the `real_changes = ...` line, insert the filter:
```python
        # Respect locked_fields — admin-corrected / audit-nulled fields must never be overwritten
        locked = ce.get("locked_fields") or []
        updates = filter_locked_fields(updates, locked)
```

**(d)** Update the change log print: if `locked` is non-empty, show a note so the user sees it:
```python
        if locked:
            click.echo(f"    (respecting locked_fields={locked})")
```
Insert that line right after the previous block, before the `real_changes = ...` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd enricher && pytest tests/test_sync_locked_fields.py -v && pytest tests/ -v`
Expected: new tests pass; the full suite still passes.

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/sync.py enricher/tests/test_sync_locked_fields.py
git commit -m "feat(enricher): sync respects calendar_events.locked_fields"
```

---

### Task 10: Admin PATCH auto-appends `locked_fields`

**Files:**
- Modify: `backend/src/routes/calendarEvents.js`

- [ ] **Step 1: Determine the non-locking field set**

The following fields are metadata/control and must NOT be auto-locked when an admin edits them:
- `status`, `updated_at`, `locked_fields`, `last_verified_at`, `scraped_at`, `source`, `source_id`, `source_url`, `source_links`, `enriched_at`

Every other field name present in `request.body` gets appended to `locked_fields`.

- [ ] **Step 2: Update the PATCH handler**

Replace the body of the handler at lines 172-186 in `backend/src/routes/calendarEvents.js` with:

```javascript
  fastify.patch('/calendar-events/:id', async (request, reply) => {
    const { id } = request.params
    const updates = { ...request.body, updated_at: new Date().toISOString() }
    if (updates.voivodeship) updates.voivodeship = capitalizeVoivodeship(updates.voivodeship)

    // Fields that are metadata / control and must NOT auto-lock when edited.
    const NON_LOCKING_FIELDS = new Set([
      'status', 'updated_at', 'locked_fields',
      'last_verified_at', 'scraped_at',
      'source', 'source_id', 'source_url', 'source_links',
      'enriched_at',
    ])

    // Data fields the admin is changing in this request — all of these become sticky.
    const editedDataFields = Object.keys(request.body || {})
      .filter(k => !NON_LOCKING_FIELDS.has(k))

    if (editedDataFields.length > 0 && !('locked_fields' in request.body)) {
      // Read current locked_fields, merge, dedupe
      const { data: current, error: readErr } = await supabase
        .from('calendar_events')
        .select('locked_fields')
        .eq('id', id)
        .single()
      if (readErr) return reply.status(400).send({ error: readErr.message })
      const existing = Array.isArray(current?.locked_fields) ? current.locked_fields : []
      const merged = Array.from(new Set([...existing, ...editedDataFields]))
      updates.locked_fields = merged
    }

    const { data, error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })
```

- [ ] **Step 3: Manual smoke test**

Start backend: `cd backend && npm run dev` (or whatever the repo uses — check `backend/package.json` scripts).

Pick a known future `calendar_events` row and run from the project root:
```bash
curl -s -X PATCH http://localhost:3001/api/calendar-events/<ID> \
  -H "Content-Type: application/json" \
  -d '{"website": "https://new.pl"}' | jq .data.locked_fields
```
Expected: `["website"]` (or existing entries + `"website"`, deduped).

Second edit of a different field:
```bash
curl -s -X PATCH http://localhost:3001/api/calendar-events/<ID> \
  -H "Content-Type: application/json" \
  -d '{"price_from": 99}' | jq .data.locked_fields
```
Expected: `["website", "price_from"]`.

Explicit override:
```bash
curl -s -X PATCH http://localhost:3001/api/calendar-events/<ID> \
  -H "Content-Type: application/json" \
  -d '{"locked_fields": []}' | jq .data.locked_fields
```
Expected: `[]` — when the body explicitly sets `locked_fields`, the auto-append path is skipped.

If you cannot easily run the backend, skip the smoke test for this task — Task 12 re-validates end-to-end.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/calendarEvents.js
git commit -m "feat(calendar-events): PATCH auto-appends edited fields to locked_fields"
```

---

### Task 11: Documentation

**Files:**
- Modify: `enricher/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add an audit section to `enricher/README.md`**

Find the "Running" section (or the section that lists `python -m enricher run` and `sync`). Insert a new section after the `sync` subsection:

```markdown
### Audit (report-only URL review)

`audit` reviews outbound URL fields on `calendar_events` (future events only) and writes a JSONL report of how each URL looks to an LLM. It **never** writes to the database. Use the report to curate data manually or feed it into another tool.

```bash
# Audit all future events' `website` URLs
python -m enricher audit

# Limit, custom date, multiple fields, custom threshold
python -m enricher audit --limit 50 \
    --since 2026-05-01 \
    --fields website,registration_url \
    --confidence-threshold 0.85
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
```

- [ ] **Step 2: Update `CLAUDE.md`**

Find the "Local LLM Enricher" section (around line starting `## Local LLM Enricher`). In the `### Running` subsection, add to the command list:

```
python -m enricher audit                         # audit website URLs on future calendar_events (report-only)
python -m enricher audit --fields website,registration_url --limit 20
```

Just below that list, add a new paragraph:
```
**Audit command:** read-only review of outbound URL fields on `calendar_events`. Writes JSONL to `enricher/logs/audit-<ts>.jsonl`. Never mutates DB. Useful for catching wrong-year, wrong-event, or outdated URLs before they surface on the public kalendarz. See `enricher/README.md` for report shape.

**`calendar_events.locked_fields`:** a `text[]` column listing column names whose values must not be overwritten by automated writers. Admin PATCH auto-appends edited field names here so human corrections stick. The enricher sync respects this list. (publishToCalendar is insert-only and therefore unaffected.)
```

- [ ] **Step 3: Commit**

```bash
git add enricher/README.md CLAUDE.md
git commit -m "docs(enricher): document audit command and locked_fields column"
```

---

### Task 12: End-to-end smoke test

**Files:** none modified — this task is a live verification.

- [ ] **Step 1: Run the full test suite**

Run: `cd enricher && source .venv/bin/activate && pytest -v`
Expected: all tests pass (existing + the new ones across audit_fetch, audit_prompt, audit_verdict, audit, sync_locked_fields, navigate_social_hosts).

If anything fails, fix inline, recommit, and rerun until green.

- [ ] **Step 2: Run a small live audit**

Prerequisites: Ollama is running locally with `gemma3:27b`, Supabase env vars set.

Run: `cd enricher && source .venv/bin/activate && python -m enricher audit --limit 3`

Expected:
- Stdout shows `Auditing N events for fields=['website'] since=<today>` (N ≥ 1 and ≤ 3)
- Per-URL lines of the form `verdict=... conf=... path=...`
- Summary with counts by verdict
- A file `enricher/logs/audit-<ts>.jsonl` with 1–3 lines of valid JSON each

Manual sanity-check the file: each line is valid JSON, has all 14 keys, and `verdict` is one of the allowed values.

- [ ] **Step 3: Verify `locked_fields` round-trip in the DB**

Pick the `id` of an event used in the audit. From another terminal:

```bash
# Simulate an admin edit via the PATCH endpoint
curl -s -X PATCH http://localhost:3001/api/calendar-events/<ID> \
  -H "Content-Type: application/json" \
  -d '{"website": "https://human-corrected.example.pl"}'

# Verify locked_fields now contains "website"
# (via mcp__supabase__execute_sql or the admin UI)
```

Expected: `locked_fields` contains `"website"`.

Run the enricher sync to confirm it would NOT overwrite the website:
```bash
python -m enricher sync --since today --dry-run
```
Expected: the event either shows `(respecting locked_fields=['website'])` and excludes `website` from the update, or is entirely skipped as "no changes". Under no circumstances should the dry-run output show a change to `website`.

- [ ] **Step 4: Clean up test state (if needed)**

If the test PATCH left a dummy URL in the DB, restore it manually. Not automated.

- [ ] **Step 5: Final commit — mark plan complete**

No code changes expected at this step. If docs were tweaked during smoke, commit them:

```bash
git status
# If nothing to commit, skip. Otherwise:
git add <files>
git commit -m "chore: finalize audit command after smoke test"
```

---

## Notes for the implementer

- **Do not** add `locked_fields` logic to `backend/scripts/run-publish.js` or `backend/src/scrapers/index.js → publishToCalendar`. It is insert-only. Adding the logic is dead code.
- **Do not** add any Drizzle migration for `locked_fields`. `calendar_events` is a Supabase-only table (see CLAUDE.md "Supabase-only tables").
- **Do not** mutate `calendar_events` from the audit command under any flag. The contract is report-only.
- Keep `confidence_threshold` as a CLI flag (not a config constant) so the user can tune it per run without editing code.
- `enricher/logs/` already exists and is how `run` logs get stored — follow the same convention.
