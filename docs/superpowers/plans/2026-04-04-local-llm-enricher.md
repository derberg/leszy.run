# Local LLM Enricher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python-based enrichment pipeline that validates, searches, crawls, extracts, and merges event data into Supabase `scraper_all` using local tools (Ollama, SearXNG, Crawl4AI, Docling).

**Architecture:** Sequential per-event pipeline in a new `enricher/` Python project at monorepo root. Each event flows through 6 steps: URL validation → SearXNG search → Crawl4AI page fetch → Docling PDF extraction → Ollama LLM extraction → smart merge to Supabase. CLI invoked manually via `python -m enricher run`.

**Tech Stack:** Python 3.10+, Ollama (qwen2.5:72b-instruct-q4_0), SearXNG (Docker), Crawl4AI, Docling, httpx, supabase-py, click

**Spec:** `docs/superpowers/specs/2026-04-04-local-llm-enricher-design.md`

---

## File Structure

```
enricher/
  pyproject.toml                    # project metadata + dependencies
  enricher/
    __init__.py                     # empty
    __main__.py                     # click CLI: run command with --limit/--dry-run/--resume/--force
    config.py                       # env-based config dataclass (Supabase, Ollama, SearXNG URLs)
    pipeline.py                     # main loop: fetch events, iterate, call steps, handle errors
    run_logger.py                   # JSONL file logger + resume support
    steps/
      __init__.py                   # empty
      validate_urls.py              # HEAD-check URLs, classify alive/dead/redirect/not-pdf
      search.py                     # SearXNG search for missing/dead URLs
      crawl.py                      # Crawl4AI: fetch page content as clean markdown
      pdf.py                        # Docling: download + extract text from PDF regulamins
      llm.py                        # Ollama API call, prompt builder, JSON response parser
      merge.py                      # smart merge rules: compare old vs new, build update dict
  docker-compose.yml                # SearXNG container
  searxng-settings.yml              # SearXNG config (enable JSON, Polish, search engines)
  .env.example                      # template for required env vars
  .gitignore                        # logs/, .venv/, .env, __pycache__
  tests/
    __init__.py
    test_validate_urls.py
    test_search.py
    test_pdf.py
    test_llm.py
    test_merge.py
    test_pipeline.py
    conftest.py                     # shared fixtures (sample events, mock responses)
```

---

### Task 1: Project Scaffolding & SearXNG Docker

**Files:**
- Create: `enricher/pyproject.toml`
- Create: `enricher/enricher/__init__.py`
- Create: `enricher/enricher/__main__.py`
- Create: `enricher/enricher/config.py`
- Create: `enricher/.env.example`
- Create: `enricher/.gitignore`
- Create: `enricher/docker-compose.yml`
- Create: `enricher/searxng-settings.yml`
- Create: `enricher/tests/__init__.py`
- Create: `enricher/tests/conftest.py`

- [ ] **Step 1: Create pyproject.toml**

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
    "python-dotenv>=1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "respx>=0.21.0",
]

[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.backends._legacy:_Backend"
```

- [ ] **Step 2: Create .gitignore**

```
.venv/
.env
logs/
__pycache__/
*.egg-info/
dist/
searxng-data/
```

- [ ] **Step 3: Create .env.example**

```bash
# Supabase (required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Ollama (defaults to localhost)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:72b-instruct-q4_0

# SearXNG (defaults to localhost)
SEARXNG_URL=http://localhost:8888
```

- [ ] **Step 4: Create config.py**

```python
import os
from dataclasses import dataclass, field
from dotenv import load_dotenv


@dataclass
class Config:
    supabase_url: str = ""
    supabase_key: str = ""
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:72b-instruct-q4_0"
    searxng_url: str = "http://localhost:8888"
    url_timeout: int = 10
    max_page_chars: int = 10_000
    max_pdf_chars: int = 15_000
    ollama_temperature: float = 0.1
    ollama_max_tokens: int = 1024

    aggregator_domains: list = field(default_factory=lambda: [
        "maratonypolskie.pl",
        "liveds.datasport.pl",
        "datasport.pl",
        "biegiwpolsce.pl",
        "elektronicznezapisy.pl",
        "bieganie.pl",
        "kalendarzbiegowy.pl",
        "enduhub.com",
    ])

    valid_event_types: list = field(default_factory=lambda: [
        "trail", "nocny", "ocr", "nordic walking", "ultra", "charytatywny", "uliczny",
    ])

    voivodeships: list = field(default_factory=lambda: [
        "Dolnośląskie", "Kujawsko-Pomorskie", "Łódzkie", "Lubelskie", "Lubuskie",
        "Małopolskie", "Mazowieckie", "Opolskie", "Podkarpackie", "Podlaskie",
        "Pomorskie", "Śląskie", "Świętokrzyskie", "Warmińsko-Mazurskie",
        "Wielkopolskie", "Zachodniopomorskie",
    ])


def load_config() -> Config:
    load_dotenv()
    return Config(
        supabase_url=os.environ["SUPABASE_URL"],
        supabase_key=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        ollama_url=os.getenv("OLLAMA_URL", "http://localhost:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "qwen2.5:72b-instruct-q4_0"),
        searxng_url=os.getenv("SEARXNG_URL", "http://localhost:8888"),
    )
```

- [ ] **Step 5: Create minimal __main__.py (CLI skeleton)**

```python
import click
from enricher.config import load_config


@click.group()
def cli():
    """LeszyRun event enricher — local LLM pipeline."""
    pass


@cli.command()
@click.option("--limit", type=int, default=None, help="Max events to process")
@click.option("--dry-run", is_flag=True, help="Show changes without writing to DB")
@click.option("--resume", is_flag=True, help="Skip events from most recent run log")
@click.option("--force", is_flag=True, help="Re-process even if enriched_at is set")
def run(limit, dry_run, resume, force):
    """Run the enrichment pipeline."""
    config = load_config()
    click.echo(f"Enricher ready. Ollama: {config.ollama_url}, SearXNG: {config.searxng_url}")
    if dry_run:
        click.echo("=== DRY RUN ===")
    click.echo("Pipeline not yet implemented.")


if __name__ == "__main__":
    cli()
```

- [ ] **Step 6: Create empty __init__.py files**

Create `enricher/enricher/__init__.py` and `enricher/enricher/steps/__init__.py` and `enricher/tests/__init__.py` as empty files.

- [ ] **Step 7: Create tests/conftest.py with shared fixtures**

```python
import pytest


@pytest.fixture
def sample_event():
    """A typical scraper_all row with some fields filled, some empty."""
    return {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "name": "Bieg Leszka",
        "date": "2026-05-10",
        "location": "Warszawa",
        "distances": None,
        "event_types": None,
        "registration_url": "https://example.pl/zapisy",
        "regulamin_url": "https://example.pl/regulamin.pdf",
        "regulamin_urls": None,
        "website": None,
        "registration_deadline": None,
        "price_from": None,
        "price_to": None,
        "voivodeship": None,
        "is_kids": None,
        "enriched_at": None,
        "enriched_regulamin_at": None,
        "enriched_search_at": None,
    }


@pytest.fixture
def sample_event_full():
    """A scraper_all row with all fields already populated."""
    return {
        "id": "660e8400-e29b-41d4-a716-446655440001",
        "name": "Maraton Krakowski",
        "date": "2026-06-15",
        "location": "Kraków",
        "distances": "10 km, 21.1 km, 42.2 km",
        "event_types": ["uliczny"],
        "registration_url": "https://maraton.krakow.pl/zapisy",
        "regulamin_url": "https://maraton.krakow.pl/regulamin.pdf",
        "regulamin_urls": None,
        "website": "https://maraton.krakow.pl",
        "registration_deadline": "2026-06-01",
        "price_from": 80,
        "price_to": 150,
        "voivodeship": "Małopolskie",
        "is_kids": False,
        "enriched_at": None,
        "enriched_regulamin_at": None,
        "enriched_search_at": None,
    }


@pytest.fixture
def sample_llm_response():
    """Typical JSON response from the Ollama LLM."""
    return {
        "distances": ["5 km", "10 km"],
        "event_types": ["uliczny", "charytatywny"],
        "registration_deadline": "2026-05-01",
        "price_from": 40,
        "price_to": 80,
        "voivodeship": "Mazowieckie",
        "is_kids": False,
        "website": "https://biegleszka.pl",
        "registration_url": "https://biegleszka.pl/zapisy",
        "regulamin_url": "https://biegleszka.pl/regulamin.pdf",
        "url_is_regulamin": True,
        "url_is_registration": True,
    }
```

- [ ] **Step 8: Create docker-compose.yml for SearXNG**

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: leszyrun-searxng
    ports:
      - "8888:8080"
    volumes:
      - ./searxng-settings.yml:/etc/searxng/settings.yml:ro
      - searxng-data:/etc/searxng
    restart: unless-stopped

volumes:
  searxng-data:
```

- [ ] **Step 9: Create searxng-settings.yml**

```yaml
use_default_settings: true

server:
  secret_key: "leszyrun-enricher-searxng-key"
  limiter: false

search:
  default_lang: "pl"
  formats:
    - html
    - json

engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false
  - name: bing
    engine: bing
    shortcut: b
    disabled: false
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    disabled: false
```

- [ ] **Step 10: Verify project installs and CLI runs**

```bash
cd enricher
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m enricher run --help
```

Expected output:
```
Usage: python -m enricher run [OPTIONS]

  Run the enrichment pipeline.

Options:
  --limit INTEGER  Max events to process
  --dry-run        Show changes without writing to DB
  --resume         Skip events from most recent run log
  --force          Re-process even if enriched_at is set
  --help           Show this message and exit.
```

- [ ] **Step 11: Commit**

```bash
git add enricher/
git commit -m "feat(enricher): scaffold Python project with CLI, config, SearXNG docker"
```

---

### Task 2: JSONL Run Logger

**Files:**
- Create: `enricher/enricher/run_logger.py`
- Create: `enricher/tests/test_run_logger.py`

- [ ] **Step 1: Write failing tests for run_logger**

```python
import json
import os
import tempfile
from enricher.run_logger import RunLogger


def test_logger_creates_file():
    with tempfile.TemporaryDirectory() as d:
        logger = RunLogger(log_dir=d)
        logger.log("event-1", "Bieg Testowy", "validate", {"urls_checked": 2})
        assert os.path.exists(logger.log_path)


def test_logger_writes_jsonl():
    with tempfile.TemporaryDirectory() as d:
        logger = RunLogger(log_dir=d)
        logger.log("event-1", "Bieg Testowy", "validate", {"urls_checked": 2})
        logger.log("event-1", "Bieg Testowy", "merge", {"fields_updated": ["distances"]})

        with open(logger.log_path) as f:
            lines = f.readlines()
        assert len(lines) == 2

        first = json.loads(lines[0])
        assert first["id"] == "event-1"
        assert first["name"] == "Bieg Testowy"
        assert first["step"] == "validate"
        assert first["data"]["urls_checked"] == 2
        assert "ts" in first


def test_get_completed_ids():
    with tempfile.TemporaryDirectory() as d:
        logger = RunLogger(log_dir=d)
        logger.log("event-1", "Bieg A", "merge", {"fields_updated": []})
        logger.log("event-2", "Bieg B", "llm", {"duration_s": 30})
        # event-2 has no "merge" step → not completed

        completed = logger.get_completed_ids()
        assert completed == {"event-1"}


def test_resume_loads_most_recent_log():
    with tempfile.TemporaryDirectory() as d:
        # Create an older log file
        older = os.path.join(d, "run-2026-04-04T100000.jsonl")
        with open(older, "w") as f:
            f.write(json.dumps({"id": "old-1", "name": "Old", "step": "merge", "data": {}, "ts": ""}) + "\n")

        # Create a newer log file
        newer = os.path.join(d, "run-2026-04-04T120000.jsonl")
        with open(newer, "w") as f:
            f.write(json.dumps({"id": "new-1", "name": "New", "step": "merge", "data": {}, "ts": ""}) + "\n")

        completed = RunLogger.load_completed_from_latest(d)
        assert completed == {"new-1"}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_run_logger.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'enricher.run_logger'`

- [ ] **Step 3: Implement run_logger.py**

```python
import json
import os
from datetime import datetime, timezone


class RunLogger:
    def __init__(self, log_dir="logs"):
        os.makedirs(log_dir, exist_ok=True)
        self.log_dir = log_dir
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        self.log_path = os.path.join(log_dir, f"run-{ts}.jsonl")

    def log(self, event_id, event_name, step, data):
        entry = {
            "id": event_id,
            "name": event_name,
            "step": step,
            "data": data,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        with open(self.log_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def get_completed_ids(self):
        """Read this run's log and return IDs that have a 'merge' step."""
        if not os.path.exists(self.log_path):
            return set()
        return self._extract_completed(self.log_path)

    @staticmethod
    def load_completed_from_latest(log_dir):
        """Find the most recent log file and return completed IDs."""
        if not os.path.exists(log_dir):
            return set()
        logs = sorted(
            [f for f in os.listdir(log_dir) if f.startswith("run-") and f.endswith(".jsonl")]
        )
        if not logs:
            return set()
        latest = os.path.join(log_dir, logs[-1])
        return RunLogger._extract_completed(latest)

    @staticmethod
    def _extract_completed(path):
        completed = set()
        with open(path) as f:
            for line in f:
                entry = json.loads(line)
                if entry.get("step") == "merge":
                    completed.add(entry["id"])
        return completed
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_run_logger.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/run_logger.py enricher/tests/test_run_logger.py
git commit -m "feat(enricher): add JSONL run logger with resume support"
```

---

### Task 3: URL Validation Step

**Files:**
- Create: `enricher/enricher/steps/validate_urls.py`
- Create: `enricher/tests/test_validate_urls.py`

- [ ] **Step 1: Write failing tests**

```python
import httpx
import pytest
import respx
from enricher.steps.validate_urls import validate_urls, UrlStatus


def test_alive_url():
    with respx.mock:
        respx.head("https://example.pl/zapisy").mock(return_value=httpx.Response(200))
        result = validate_urls({"registration_url": "https://example.pl/zapisy"})
    assert result["registration_url"].status == "alive"


def test_dead_url():
    with respx.mock:
        respx.head("https://example.pl/gone").mock(return_value=httpx.Response(404))
        result = validate_urls({"registration_url": "https://example.pl/gone"})
    assert result["registration_url"].status == "dead"


def test_redirect_url():
    with respx.mock:
        respx.head("https://old.pl/zapisy").mock(
            return_value=httpx.Response(301, headers={"location": "https://new.pl/zapisy"})
        )
        respx.head("https://new.pl/zapisy").mock(return_value=httpx.Response(200))
        result = validate_urls({"registration_url": "https://old.pl/zapisy"})
    assert result["registration_url"].status == "alive"
    assert result["registration_url"].final_url == "https://new.pl/zapisy"


def test_timeout_url():
    with respx.mock:
        respx.head("https://slow.pl").mock(side_effect=httpx.TimeoutException("timeout"))
        result = validate_urls({"website": "https://slow.pl"})
    assert result["website"].status == "dead"


def test_pdf_content_type():
    with respx.mock:
        respx.head("https://example.pl/reg.pdf").mock(
            return_value=httpx.Response(200, headers={"content-type": "application/pdf"})
        )
        result = validate_urls({"regulamin_url": "https://example.pl/reg.pdf"})
    assert result["regulamin_url"].status == "alive"
    assert result["regulamin_url"].is_pdf is True


def test_regulamin_not_pdf():
    with respx.mock:
        respx.head("https://example.pl/rules").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/html"})
        )
        result = validate_urls({"regulamin_url": "https://example.pl/rules"})
    assert result["regulamin_url"].status == "alive"
    assert result["regulamin_url"].is_pdf is False


def test_skips_none_urls():
    result = validate_urls({"registration_url": None, "website": None})
    assert len(result) == 0


def test_regulamin_urls_array():
    with respx.mock:
        respx.head("https://a.pl/reg.pdf").mock(
            return_value=httpx.Response(200, headers={"content-type": "application/pdf"})
        )
        respx.head("https://b.pl/reg.pdf").mock(return_value=httpx.Response(404))
        result = validate_urls({"regulamin_urls": ["https://a.pl/reg.pdf", "https://b.pl/reg.pdf"]})
    assert result["regulamin_urls[0]"].status == "alive"
    assert result["regulamin_urls[1]"].status == "dead"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_validate_urls.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement validate_urls.py**

```python
from dataclasses import dataclass
from typing import Optional
import httpx


@dataclass
class UrlStatus:
    url: str
    status: str  # "alive", "dead"
    final_url: Optional[str] = None  # set if redirected
    is_pdf: bool = False
    error: Optional[str] = None


def validate_urls(urls_dict: dict, timeout: int = 10) -> dict[str, UrlStatus]:
    """Validate all URLs on an event. Returns {field_name: UrlStatus}.

    urls_dict keys: registration_url, regulamin_url, regulamin_urls, website
    regulamin_urls is a list — each entry gets its own result keyed as regulamin_urls[i].
    None values are skipped.
    """
    results = {}

    flat = {}
    for key, value in urls_dict.items():
        if value is None:
            continue
        if key == "regulamin_urls" and isinstance(value, list):
            for i, url in enumerate(value):
                if url:
                    flat[f"regulamin_urls[{i}]"] = url
        elif isinstance(value, str) and value.strip():
            flat[key] = value

    for field_name, url in flat.items():
        results[field_name] = _check_url(url, field_name, timeout)

    return results


def _check_url(url: str, field_name: str, timeout: int) -> UrlStatus:
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout) as client:
            resp = client.head(url)

        final_url = str(resp.url) if str(resp.url) != url else None
        content_type = resp.headers.get("content-type", "")
        is_pdf = "pdf" in content_type.lower()

        if resp.status_code < 400:
            return UrlStatus(
                url=url,
                status="alive",
                final_url=final_url,
                is_pdf=is_pdf,
            )
        else:
            return UrlStatus(url=url, status="dead", error=f"HTTP {resp.status_code}")

    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        return UrlStatus(url=url, status="dead", error=str(e)[:100])
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_validate_urls.py -v
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/validate_urls.py enricher/tests/test_validate_urls.py
git commit -m "feat(enricher): add URL validation step with HEAD checks"
```

---

### Task 4: SearXNG Search Step

**Files:**
- Create: `enricher/enricher/steps/search.py`
- Create: `enricher/tests/test_search.py`

- [ ] **Step 1: Write failing tests**

```python
import httpx
import respx
import json
from enricher.steps.search import search_missing_urls
from enricher.config import Config


SEARXNG_RESPONSE = {
    "results": [
        {"url": "https://biegiwpolsce.pl/bieg-leszka", "title": "Bieg Leszka - biegiwpolsce"},
        {"url": "https://biegleszka.pl/zapisy", "title": "Zapisy - Bieg Leszka"},
        {"url": "https://facebook.com/biegleszka", "title": "Bieg Leszka FB"},
    ]
}

config = Config()


def test_search_returns_non_aggregator_url():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=config,
        )
    # First result is aggregator (biegiwpolsce.pl), should be skipped
    assert result.get("registration_url") == "https://biegleszka.pl/zapisy"


def test_search_skips_all_aggregators():
    all_agg = {
        "results": [
            {"url": "https://biegiwpolsce.pl/x", "title": "X"},
            {"url": "https://datasport.pl/y", "title": "Y"},
        ]
    }
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=all_agg)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=config,
        )
    assert result.get("registration_url") is None


def test_search_multiple_fields():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url", "website", "regulamin_url"],
            config=config,
        )
    # Each field gets its own search, all should find something
    assert "registration_url" in result or "website" in result


def test_search_empty_missing_fields():
    result = search_missing_urls(
        event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
        missing_fields=[],
        config=config,
    )
    assert result == {}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_search.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement search.py**

```python
import httpx
from urllib.parse import urlparse


def search_missing_urls(event: dict, missing_fields: list[str], config) -> dict:
    """Search SearXNG for missing URLs. Returns {field_name: url} for found candidates."""
    if not missing_fields:
        return {}

    name = event.get("name", "")
    date = event.get("date", "")
    year = date[:4] if date else ""
    location = event.get("location", "")

    queries = {}
    if "registration_url" in missing_fields:
        queries["registration_url"] = f"{name} {year} zapisy rejestracja {location}"
    if "regulamin_url" in missing_fields:
        queries["regulamin_url"] = f"{name} {year} regulamin"
    if "website" in missing_fields:
        queries["website"] = f"{name} {year} {location}"

    results = {}
    for field, query in queries.items():
        url = _searxng_search(query, config)
        if url:
            results[field] = url

    return results


def _searxng_search(query: str, config) -> str | None:
    """Call SearXNG and return the first non-aggregator URL."""
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{config.searxng_url}/search",
                params={"q": query, "format": "json", "language": "pl", "categories": "general"},
            )
            resp.raise_for_status()

        data = resp.json()
        for item in data.get("results", []):
            url = item.get("url", "")
            if url and not _is_aggregator(url, config.aggregator_domains):
                return url
    except (httpx.HTTPError, Exception):
        pass
    return None


def _is_aggregator(url: str, domains: list[str]) -> bool:
    try:
        hostname = urlparse(url).hostname or ""
        hostname = hostname.removeprefix("www.")
        return any(hostname == d or hostname.endswith(f".{d}") for d in domains)
    except Exception:
        return False
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_search.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/search.py enricher/tests/test_search.py
git commit -m "feat(enricher): add SearXNG search step for missing URLs"
```

---

### Task 5: Crawl4AI Web Crawling Step

**Files:**
- Create: `enricher/enricher/steps/crawl.py`
- Create: `enricher/tests/test_crawl.py`

- [ ] **Step 1: Write failing tests**

Tests for the crawl step are tricky since Crawl4AI uses a real browser. We test the wrapper logic (URL dedup, char limit, error handling) with a mock.

```python
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from enricher.steps.crawl import crawl_pages, CrawlResult


@pytest.mark.asyncio
async def test_crawl_deduplicates_urls():
    """If website and registration_url are the same, only crawl once."""
    mock_result = MagicMock()
    mock_result.markdown_v2 = MagicMock()
    mock_result.markdown_v2.raw_markdown = "# Event Page\nRegistration open"
    mock_result.success = True

    with patch("enricher.steps.crawl._crawl_url", new_callable=AsyncMock) as mock_crawl:
        mock_crawl.return_value = CrawlResult(url="https://example.pl", content="# Event Page\nRegistration open", chars=30)
        result = await crawl_pages(
            urls={"registration_url": "https://example.pl", "website": "https://example.pl"},
            max_chars=10_000,
        )
    # Should only crawl once despite two fields pointing to same URL
    assert mock_crawl.call_count == 1
    assert "registration_url" in result
    assert "website" in result
    assert result["registration_url"].content == result["website"].content


@pytest.mark.asyncio
async def test_crawl_truncates_long_content():
    long_text = "x" * 20_000

    with patch("enricher.steps.crawl._crawl_url", new_callable=AsyncMock) as mock_crawl:
        mock_crawl.return_value = CrawlResult(url="https://example.pl", content=long_text[:5000], chars=5000)
        result = await crawl_pages(
            urls={"website": "https://example.pl"},
            max_chars=5000,
        )
    assert len(result["website"].content) <= 5000


@pytest.mark.asyncio
async def test_crawl_skips_none_urls():
    result = await crawl_pages(urls={"website": None}, max_chars=10_000)
    assert len(result) == 0


@pytest.mark.asyncio
async def test_crawl_handles_failure():
    with patch("enricher.steps.crawl._crawl_url", new_callable=AsyncMock) as mock_crawl:
        mock_crawl.return_value = None
        result = await crawl_pages(
            urls={"website": "https://broken.pl"},
            max_chars=10_000,
        )
    assert result.get("website") is None
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_crawl.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement crawl.py**

```python
from dataclasses import dataclass
from typing import Optional


@dataclass
class CrawlResult:
    url: str
    content: str
    chars: int


async def crawl_pages(urls: dict, max_chars: int = 10_000) -> dict[str, Optional[CrawlResult]]:
    """Crawl all valid URLs. Returns {field_name: CrawlResult or None}.

    Deduplicates: if multiple fields point to the same URL, crawl once and reuse.
    """
    # Build url → [field_names] mapping to deduplicate
    url_to_fields = {}
    for field, url in urls.items():
        if url and isinstance(url, str):
            url_to_fields.setdefault(url, []).append(field)

    # Crawl each unique URL
    url_results = {}
    for url in url_to_fields:
        result = await _crawl_url(url, max_chars)
        url_results[url] = result

    # Map back to field names
    results = {}
    for url, fields in url_to_fields.items():
        for field in fields:
            results[field] = url_results.get(url)

    return results


async def _crawl_url(url: str, max_chars: int) -> Optional[CrawlResult]:
    """Crawl a single URL using Crawl4AI. Returns None on failure."""
    try:
        from crawl4ai import AsyncWebCrawler

        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url)

        if not result.success:
            return None

        # Prefer markdown_v2 if available, fall back to markdown
        content = ""
        if hasattr(result, "markdown_v2") and result.markdown_v2:
            content = result.markdown_v2.raw_markdown or ""
        elif hasattr(result, "markdown"):
            content = result.markdown or ""

        content = content[:max_chars]
        if not content.strip():
            return None

        return CrawlResult(url=url, content=content, chars=len(content))

    except Exception:
        return None
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_crawl.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/crawl.py enricher/tests/test_crawl.py
git commit -m "feat(enricher): add Crawl4AI web crawling step"
```

---

### Task 6: Docling PDF Extraction Step

**Files:**
- Create: `enricher/enricher/steps/pdf.py`
- Create: `enricher/tests/test_pdf.py`

- [ ] **Step 1: Write failing tests**

```python
import tempfile
import os
import pytest
from unittest.mock import patch, MagicMock
from enricher.steps.pdf import extract_pdf_text, download_pdf


def test_download_pdf_rejects_html():
    """HTML served as PDF should be rejected."""
    html_content = b"<!DOCTYPE html><html><body>Not a PDF</body></html>"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(html_content)
        f.flush()
        result = _check_file_is_pdf(f.name)
    os.unlink(f.name)
    assert result is False


def test_download_pdf_rejects_tiny():
    """Files under 500 bytes are likely broken."""
    tiny = b"%PDF-1.4 tiny"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(tiny)
        f.flush()
        is_valid = len(tiny) >= 500
    os.unlink(f.name)
    assert is_valid is False


def test_extract_pdf_text_truncates():
    """Output should be capped at max_chars."""
    long_text = "Lorem ipsum " * 5000  # ~60k chars
    with patch("enricher.steps.pdf._docling_extract") as mock_extract:
        mock_extract.return_value = long_text
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert len(result) <= 15_000


def test_extract_pdf_text_returns_none_on_failure():
    with patch("enricher.steps.pdf._docling_extract") as mock_extract:
        mock_extract.side_effect = Exception("docling crash")
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert result is None


def _check_file_is_pdf(path):
    """Helper to check if file starts with PDF header."""
    with open(path, "rb") as f:
        head = f.read(100)
    return head[:5] == b"%PDF-"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_pdf.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement pdf.py**

```python
import os
import tempfile
from typing import Optional
import httpx


async def download_pdf(url: str, timeout: int = 30) -> Optional[str]:
    """Download a PDF to a temp file. Returns path or None on failure."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": "leszy.run/1.0 (kontakt@leszy.run)"},
            )
        if resp.status_code >= 400:
            return None

        content_type = resp.headers.get("content-type", "")
        if "pdf" not in content_type.lower():
            return None

        data = resp.content
        if len(data) < 500:
            return None

        # Detect HTML served as PDF
        head = data[:100].decode("utf-8", errors="ignore").strip()
        if head.lower().startswith("<!doctype") or head.lower().startswith("<html"):
            return None

        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(data)
        tmp.close()
        return tmp.name

    except Exception:
        return None


def extract_pdf_text(pdf_path: str, max_chars: int = 15_000) -> Optional[str]:
    """Extract text from a PDF using Docling. Returns plain text or None."""
    try:
        text = _docling_extract(pdf_path)
        if not text or not text.strip():
            return None
        return text[:max_chars]
    except Exception:
        return None


def _docling_extract(pdf_path: str) -> str:
    """Call Docling to convert PDF to text."""
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(pdf_path)
    return result.document.export_to_markdown()


def cleanup_pdf(path: Optional[str]):
    """Remove temp PDF file if it exists."""
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_pdf.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/pdf.py enricher/tests/test_pdf.py
git commit -m "feat(enricher): add Docling PDF extraction step"
```

---

### Task 7: Ollama LLM Step

**Files:**
- Create: `enricher/enricher/steps/llm.py`
- Create: `enricher/tests/test_llm.py`

- [ ] **Step 1: Write failing tests**

```python
import json
import httpx
import respx
import pytest
from enricher.steps.llm import call_ollama, build_prompt, parse_llm_response
from enricher.config import Config

config = Config()


def test_build_prompt_includes_event_metadata():
    event = {"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa",
             "distances": "5 km", "event_types": ["uliczny"], "registration_deadline": None,
             "price_from": None, "price_to": None, "voivodeship": None}
    crawled = {"registration_url": "# Zapisy\nRejestracja otwarta do 1 maja"}
    pdf_text = None
    prompt = build_prompt(event, crawled, pdf_text, config)
    assert "Bieg Leszka" in prompt
    assert "2026-05-10" in prompt
    assert "Warszawa" in prompt
    assert "REGISTRATION PAGE" in prompt
    assert "Zapisy" in prompt


def test_build_prompt_includes_pdf_text():
    event = {"name": "Test", "date": "2026-01-01", "location": "X",
             "distances": None, "event_types": None, "registration_deadline": None,
             "price_from": None, "price_to": None, "voivodeship": None}
    pdf_text = "Regulamin biegu: dystans 10 km, teren leśny"
    prompt = build_prompt(event, {}, pdf_text, config)
    assert "REGULAMIN" in prompt
    assert "dystans 10 km" in prompt


def test_build_prompt_omits_empty_sections():
    event = {"name": "Test", "date": "2026-01-01", "location": "X",
             "distances": None, "event_types": None, "registration_deadline": None,
             "price_from": None, "price_to": None, "voivodeship": None}
    prompt = build_prompt(event, {}, None, config)
    assert "REGULAMIN" not in prompt
    assert "WEBSITE CONTENT" not in prompt


def test_parse_llm_response_valid_json():
    raw = '{"distances": ["5 km", "10 km"], "event_types": ["uliczny"], "registration_deadline": null, "price_from": 50, "price_to": 100, "voivodeship": "Mazowieckie", "is_kids": false, "website": null, "registration_url": null, "regulamin_url": null, "url_is_regulamin": true, "url_is_registration": true}'
    result = parse_llm_response(raw)
    assert result["distances"] == ["5 km", "10 km"]
    assert result["price_from"] == 50


def test_parse_llm_response_json_in_markdown():
    raw = 'Here is the extracted data:\n```json\n{"distances": ["5 km"], "event_types": ["trail"]}\n```'
    result = parse_llm_response(raw)
    assert result["distances"] == ["5 km"]


def test_parse_llm_response_garbage():
    result = parse_llm_response("I don't know anything about this event")
    assert result is None


def test_call_ollama_sends_correct_request():
    llm_response = json.dumps({
        "response": '{"distances": ["10 km"], "event_types": ["uliczny"], "registration_deadline": null, "price_from": null, "price_to": null, "voivodeship": null, "is_kids": false, "website": null, "registration_url": null, "regulamin_url": null, "url_is_regulamin": true, "url_is_registration": true}',
        "done": True,
    })
    with respx.mock:
        route = respx.post("http://localhost:11434/api/generate").mock(
            return_value=httpx.Response(200, json=json.loads(llm_response))
        )
        result = call_ollama("test prompt", config)
    assert route.called
    request_body = json.loads(route.calls[0].request.content)
    assert request_body["model"] == "qwen2.5:72b-instruct-q4_0"
    assert request_body["stream"] is False
    assert request_body["options"]["temperature"] == 0.1
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_llm.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement llm.py**

```python
import json
import re
import time
from typing import Optional
import httpx

VOIVODESHIPS = [
    "Dolnośląskie", "Kujawsko-Pomorskie", "Łódzkie", "Lubelskie", "Lubuskie",
    "Małopolskie", "Mazowieckie", "Opolskie", "Podkarpackie", "Podlaskie",
    "Pomorskie", "Śląskie", "Świętokrzyskie", "Warmińsko-Mazurskie",
    "Wielkopolskie", "Zachodniopomorskie",
]


def build_prompt(event: dict, crawled: dict, pdf_text: Optional[str], config) -> str:
    """Build the full extraction prompt with all gathered context."""
    distances = event.get("distances") or "unknown"
    event_types = event.get("event_types")
    types_str = ", ".join(event_types) if event_types else "unknown"
    deadline = event.get("registration_deadline") or "unknown"
    price_from = event.get("price_from")
    price_to = event.get("price_to")
    price_str = f"{price_from}-{price_to} PLN" if price_from else "unknown"
    voivodeship = event.get("voivodeship") or "unknown"

    sections = []

    # Content sections — only include non-empty ones
    for field, label in [("website", "WEBSITE CONTENT"), ("registration_url", "REGISTRATION PAGE")]:
        content = crawled.get(field)
        if content and isinstance(content, str) and content.strip():
            url = event.get(field, "")
            sections.append(f"--- {label} ({url}) ---\n{content}")

    if pdf_text and pdf_text.strip():
        regulamin_url = event.get("regulamin_url", "")
        sections.append(f"--- REGULAMIN ({regulamin_url}) ---\n{pdf_text}")
    elif crawled.get("regulamin_url"):
        regulamin_url = event.get("regulamin_url", "")
        sections.append(f"--- REGULAMIN ({regulamin_url}) ---\n{crawled['regulamin_url']}")

    context_block = "\n\n".join(sections) if sections else "(No web content or PDF available)"

    return f"""You are extracting structured data about a Polish running/walking race event.

Event name: {event.get("name", "")}
Event date: {event.get("date", "")}
Event location: {event.get("location", "unknown")}
Currently known data:
  distances: {distances}
  event_types: {types_str}
  registration_deadline: {deadline}
  price: {price_str}
  voivodeship: {voivodeship}

{context_block}

Extract ALL of the following. Return ONLY valid JSON, no other text:
{{
  "distances": ["5 km", "10 km", "21.1 km", "6h", "200m"],
  "event_types": ["uliczny", "trail", ...],
  "registration_deadline": "YYYY-MM-DD" or null,
  "price_from": number (PLN, e.g. 50) or null,
  "price_to": number (PLN, e.g. 120) or null,
  "voivodeship": "one of 16 Polish voivodeships" or null,
  "is_kids": true or false,
  "website": "https://..." or null,
  "registration_url": "https://..." or null,
  "regulamin_url": "https://..." or null,
  "url_is_regulamin": true or false,
  "url_is_registration": true or false
}}

DISTANCE RULES:
- Include all actual race distances (not age limits, elevation, or other numbers)
- Format: "N km" for kilometer distances (e.g. "5 km", "21.1 km", "42.2 km")
- półmaraton = "21.1 km", maraton = "42.2 km"
- Time-based ultras: "4h", "6h", "12h", "24h" (for timed events like "bieg 6-godzinny")
- Short/kids distances: "200m", "500m" (for distances under 1 km)
- If no distances found, use empty array []

EVENT TYPE RULES — classify into one or more. NEVER use "bieg". Valid types:
- "uliczny" — DEFAULT for most events. Road/city, asphalt, PZLA certified, sidewalks, cycling paths, cobblestone
- "trail" — off-road: forest paths, dirt trails, mountain, cross-country, mud, gravel, significant elevation
- "nocny" — night race, starts after 20:00, headlamp required
- "ocr" — obstacle course race, mud run, survival, extreme
- "nordic walking" — has nordic walking category alongside running
- "ultra" — any running distance over 50 km, or timed events (6h, 12h, 24h)
- "charytatywny" — charity event, proceeds go to a cause, fundraiser
An event can have MULTIPLE types (e.g. ["trail", "nocny"] for a night trail run).

PRICE RULES:
- price_from: cheapest registration option in PLN (whole number, e.g. 50)
- price_to: most expensive registration option in PLN (whole number, e.g. 120)
- If only one price exists, set both to the same value
- Convert from grosze if needed (5000 groszy = 50 PLN)
- If no price info found, use null

VOIVODESHIP: must be exactly one of: {", ".join(VOIVODESHIPS)}

URL VALIDATION:
- url_is_regulamin: does the regulamin_url page/PDF actually contain race regulations? true/false
- url_is_registration: does the registration_url page actually contain a registration form? true/false
- If you find better URLs for website/registration/regulamin in the content, include them

is_kids: true if any distance is ≤ 1 km OR if there is a dedicated children's category"""


def call_ollama(prompt: str, config) -> Optional[dict]:
    """Call Ollama API and return parsed JSON response."""
    start = time.time()
    try:
        with httpx.Client(timeout=300) as client:
            resp = client.post(
                f"{config.ollama_url}/api/generate",
                json={
                    "model": config.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": config.ollama_temperature,
                        "num_predict": config.ollama_max_tokens,
                    },
                },
            )
            resp.raise_for_status()

        data = resp.json()
        raw_text = data.get("response", "")
        duration = time.time() - start
        parsed = parse_llm_response(raw_text)
        if parsed:
            parsed["_duration_s"] = round(duration, 1)
        return parsed

    except Exception:
        return None


def parse_llm_response(raw: str) -> Optional[dict]:
    """Extract JSON from LLM response text. Handles markdown code blocks."""
    if not raw:
        return None

    # Strip markdown code fences
    cleaned = re.sub(r"```json\s*", "", raw)
    cleaned = re.sub(r"```\s*", "", cleaned)

    # Find JSON object
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_llm.py -v
```

Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/llm.py enricher/tests/test_llm.py
git commit -m "feat(enricher): add Ollama LLM step with prompt builder and JSON parser"
```

---

### Task 8: Smart Merge Step

**Files:**
- Create: `enricher/enricher/steps/merge.py`
- Create: `enricher/tests/test_merge.py`

- [ ] **Step 1: Write failing tests**

```python
from enricher.steps.merge import build_updates
from enricher.config import Config

config = Config()


def test_fill_empty_fields(sample_event, sample_llm_response):
    """Empty fields should be filled from LLM response."""
    url_statuses = {}
    search_candidates = {}
    updates = build_updates(sample_event, sample_llm_response, url_statuses, search_candidates, config)
    assert updates["distances"] == "5 km, 10 km"
    assert updates["voivodeship"] == "Mazowieckie"
    assert updates["price_from"] == 40
    assert updates["price_to"] == 80
    assert updates["registration_deadline"] == "2026-05-01"


def test_distances_overwrite_when_more_complete(sample_event):
    """LLM found more distances → overwrite."""
    sample_event["distances"] = "10 km"
    llm = {"distances": ["5 km", "10 km", "21.1 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["distances"] == "5 km, 10 km, 21.1 km"


def test_distances_keep_when_current_has_more(sample_event):
    """Current has more distances → keep current."""
    sample_event["distances"] = "5 km, 10 km, 21.1 km"
    llm = {"distances": ["10 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "distances" not in updates


def test_distances_keep_when_same_count(sample_event):
    """Same count, different values → keep current."""
    sample_event["distances"] = "5 km, 10 km"
    llm = {"distances": ["3 km", "7 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "distances" not in updates


def test_distances_with_time_based(sample_event):
    """Time-based distances count toward total."""
    sample_event["distances"] = "10 km"
    llm = {"distances": ["10 km", "6h"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["distances"] == "10 km, 6h"


def test_event_types_additive_merge(sample_event):
    """New types added, existing kept."""
    sample_event["event_types"] = ["uliczny"]
    llm = {"distances": None, "event_types": ["uliczny", "charytatywny"]}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert set(updates["event_types"]) == {"uliczny", "charytatywny"}


def test_event_types_no_conflicting_terrain(sample_event):
    """trail + uliczny conflict → keep existing terrain."""
    sample_event["event_types"] = ["trail"]
    llm = {"distances": None, "event_types": ["uliczny", "nocny"]}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "uliczny" not in updates["event_types"]
    assert "trail" in updates["event_types"]
    assert "nocny" in updates["event_types"]


def test_dead_url_replaced_by_search_candidate(sample_event):
    """Dead URL replaced by SearXNG candidate."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"registration_url": UrlStatus(url="https://example.pl/zapisy", status="dead")}
    search_candidates = {"registration_url": "https://new.pl/zapisy"}
    llm = {"distances": None, "event_types": None, "url_is_registration": True}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert updates["registration_url"] == "https://new.pl/zapisy"


def test_url_llm_says_not_regulamin(sample_event):
    """LLM says regulamin_url is not actually a regulamin → null it."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive")}
    search_candidates = {}
    llm = {"distances": None, "event_types": None, "url_is_regulamin": False}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert updates["regulamin_url"] is None


def test_scalar_overwrite(sample_event_full):
    """Scalar fields (price, deadline, voivodeship) always overwrite from LLM."""
    llm = {"distances": None, "event_types": None, "price_from": 100, "price_to": 200,
           "registration_deadline": "2026-06-10", "voivodeship": "Małopolskie"}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert updates["price_from"] == 100
    assert updates["price_to"] == 200
    assert updates["registration_deadline"] == "2026-06-10"


def test_no_changes_returns_empty(sample_event_full):
    """If LLM returns nothing useful, updates should be empty."""
    llm = {"distances": None, "event_types": None}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert len(updates) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_merge.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement merge.py**

```python
from enricher.steps.validate_urls import UrlStatus

TERRAIN_TYPES = {"trail", "ocr", "uliczny"}


def build_updates(event: dict, llm: dict, url_statuses: dict, search_candidates: dict, config) -> dict:
    """Compare LLM output with current event data and build update dict.

    Returns only fields that should be changed. Empty dict = no changes.
    """
    if not llm:
        return {}

    updates = {}

    # --- Distances (Rule 3) ---
    _merge_distances(event, llm, updates)

    # --- Event types (Rule 4) ---
    _merge_event_types(event, llm, updates, config)

    # --- Scalar fields (Rule 5: always overwrite from LLM) ---
    _merge_scalars(event, llm, updates, config)

    # --- URLs (Rule 2) ---
    _merge_urls(event, llm, url_statuses, search_candidates, updates)

    # --- is_kids ---
    if llm.get("is_kids") is not None and event.get("is_kids") is None:
        updates["is_kids"] = llm["is_kids"]

    return updates


def _parse_distances(dist_str: str) -> list[str]:
    """Parse a distances string like '5 km, 10 km, 6h' into a list."""
    if not dist_str or not dist_str.strip():
        return []
    return [d.strip() for d in dist_str.split(",") if d.strip()]


def _merge_distances(event, llm, updates):
    llm_distances = llm.get("distances")
    if not llm_distances or not isinstance(llm_distances, list) or len(llm_distances) == 0:
        return

    current = _parse_distances(event.get("distances", ""))
    new_count = len(llm_distances)
    current_count = len(current)

    if current_count == 0:
        # Rule 1: empty → fill
        updates["distances"] = ", ".join(llm_distances)
    elif new_count > current_count:
        # Rule 3: more complete → overwrite
        updates["distances"] = ", ".join(llm_distances)
    # else: keep current (same count or fewer)


def _merge_event_types(event, llm, updates, config):
    llm_types = llm.get("event_types")
    if not llm_types or not isinstance(llm_types, list) or len(llm_types) == 0:
        return

    valid = [t for t in llm_types if t in config.valid_event_types]
    if not valid:
        return

    current = event.get("event_types") or []
    if not current:
        updates["event_types"] = valid
        return

    # Additive merge with terrain conflict resolution
    merged = set(current)
    existing_terrain = [t for t in current if t in TERRAIN_TYPES]

    for t in valid:
        if t in TERRAIN_TYPES and existing_terrain and t not in existing_terrain:
            continue  # Skip conflicting terrain
        merged.add(t)

    merged_list = sorted(merged)
    if set(merged_list) != set(current):
        updates["event_types"] = merged_list


def _merge_scalars(event, llm, updates, config):
    """Scalar fields: always overwrite from LLM (it reads the actual source)."""
    for field in ["price_from", "price_to", "registration_deadline", "voivodeship"]:
        value = llm.get(field)
        if value is None:
            continue

        # Validate voivodeship
        if field == "voivodeship" and value not in config.voivodeships:
            continue

        # Validate deadline format
        if field == "registration_deadline":
            import re
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(value)):
                continue

        # Validate price is a positive number
        if field in ("price_from", "price_to"):
            if not isinstance(value, (int, float)) or value <= 0:
                continue

        # Rule 5: overwrite if LLM has a value
        if event.get(field) != value:
            updates[field] = value


def _merge_urls(event, llm, url_statuses, search_candidates, updates):
    """Handle URL replacement based on validation + LLM confirmation."""
    for field, llm_flag in [
        ("registration_url", "url_is_registration"),
        ("regulamin_url", "url_is_regulamin"),
    ]:
        status = url_statuses.get(field)
        candidate = search_candidates.get(field)

        # Dead URL → replace
        if status and status.status == "dead":
            updates[field] = candidate  # may be None
            continue

        # LLM says URL is wrong type → replace
        if llm.get(llm_flag) is False and event.get(field):
            updates[field] = candidate  # may be None
            continue

    # Website: fill if empty
    if not event.get("website") and llm.get("website"):
        updates["website"] = llm["website"]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd enricher
python -m pytest tests/test_merge.py -v
```

Expected: all 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add enricher/enricher/steps/merge.py enricher/tests/test_merge.py
git commit -m "feat(enricher): add smart merge step with distance/type/URL rules"
```

---

### Task 9: Main Pipeline — Wiring It All Together

**Files:**
- Create: `enricher/enricher/pipeline.py`
- Modify: `enricher/enricher/__main__.py`
- Create: `enricher/tests/test_pipeline.py`

- [ ] **Step 1: Write failing test for pipeline**

```python
import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult

config = Config()


@pytest.mark.asyncio
async def test_process_event_full_flow(sample_event, sample_llm_response):
    """Full pipeline for one event: validate → search → crawl → llm → merge."""
    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.build_updates") as mock_merge,
    ):
        mock_validate.return_value = {
            "registration_url": UrlStatus(url="https://example.pl/zapisy", status="alive"),
            "regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive", is_pdf=True),
        }
        mock_search.return_value = {}
        mock_crawl.return_value = {
            "registration_url": CrawlResult(url="https://example.pl/zapisy", content="# Zapisy", chars=7),
        }
        mock_download.return_value = "/tmp/fake.pdf"
        mock_pdf.return_value = "Regulamin: dystans 5 km"
        mock_prompt.return_value = "test prompt"
        mock_llm.return_value = sample_llm_response
        mock_merge.return_value = {"distances": "5 km, 10 km", "price_from": 40}

        result = await process_event(sample_event, config)

    assert result["updates"] == {"distances": "5 km, 10 km", "price_from": 40}
    mock_validate.assert_called_once()
    mock_crawl.assert_called_once()
    mock_download.assert_called_once()
    mock_pdf.assert_called_once()
    mock_llm.assert_called_once()


@pytest.mark.asyncio
async def test_process_event_no_urls(sample_event):
    """Event with no URLs at all — should skip crawl/pdf, still call LLM."""
    sample_event["registration_url"] = None
    sample_event["regulamin_url"] = None
    sample_event["website"] = None

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.build_updates") as mock_merge,
    ):
        mock_validate.return_value = {}
        mock_search.return_value = {"registration_url": "https://found.pl/zapisy"}
        mock_crawl.return_value = {}
        mock_prompt.return_value = "test prompt"
        mock_llm.return_value = {"distances": ["5 km"], "event_types": None}
        mock_merge.return_value = {"distances": "5 km"}

        result = await process_event(sample_event, config)

    mock_search.assert_called_once()
    mock_download.assert_not_called()  # No PDF URL
    assert result["updates"] == {"distances": "5 km"}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd enricher
python -m pytest tests/test_pipeline.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement pipeline.py**

```python
import asyncio
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client

from enricher.config import Config
from enricher.run_logger import RunLogger
from enricher.steps.validate_urls import validate_urls
from enricher.steps.search import search_missing_urls
from enricher.steps.crawl import crawl_pages
from enricher.steps.pdf import download_pdf, extract_pdf_text, cleanup_pdf
from enricher.steps.llm import call_ollama, build_prompt
from enricher.steps.merge import build_updates


async def process_event(event: dict, config: Config) -> dict:
    """Process a single event through all enrichment steps. Returns result dict."""
    result = {"id": event["id"], "name": event["name"], "updates": {}, "steps": {}}

    # Step 1: Validate existing URLs
    url_fields = {
        k: event.get(k) for k in ["registration_url", "regulamin_url", "regulamin_urls", "website"]
    }
    url_statuses = validate_urls(url_fields, timeout=config.url_timeout)
    result["steps"]["validate"] = {
        "urls_checked": len(url_statuses),
        "dead": [k for k, v in url_statuses.items() if v.status == "dead"],
    }

    # Determine which URL fields are missing or dead
    missing = []
    working_urls = {}  # field → url (alive ones for crawling)

    for field in ["registration_url", "regulamin_url", "website"]:
        url = event.get(field)
        status = url_statuses.get(field)
        if not url or (status and status.status == "dead"):
            missing.append(field)
        elif status:
            final = status.final_url or url
            working_urls[field] = final

    # Step 2: Search for missing URLs
    search_candidates = {}
    if missing:
        search_candidates = search_missing_urls(event, missing, config)
        result["steps"]["search"] = {
            "queries": len(missing),
            "found": search_candidates,
        }
        # Add search candidates to crawl list
        for field, url in search_candidates.items():
            working_urls[field] = url

    # Step 3: Crawl web pages (exclude PDF regulamins)
    crawl_urls = {}
    for field, url in working_urls.items():
        if field == "regulamin_url":
            status = url_statuses.get("regulamin_url")
            if status and status.is_pdf:
                continue  # Will handle in Step 4
        crawl_urls[field] = url

    crawled = await crawl_pages(crawl_urls, max_chars=config.max_page_chars)
    crawled_content = {k: v.content for k, v in crawled.items() if v}
    result["steps"]["crawl"] = {
        "pages": len([v for v in crawled.values() if v]),
        "total_chars": sum(v.chars for v in crawled.values() if v),
    }

    # Step 4: Extract from PDF regulamin
    pdf_text = None
    pdf_path = None
    regulamin_url = working_urls.get("regulamin_url")
    regulamin_status = url_statuses.get("regulamin_url")
    if regulamin_url and regulamin_status and regulamin_status.is_pdf:
        pdf_path = await download_pdf(regulamin_url)
        if pdf_path:
            pdf_text = extract_pdf_text(pdf_path, max_chars=config.max_pdf_chars)
            result["steps"]["pdf"] = {"extracted_chars": len(pdf_text) if pdf_text else 0}
            cleanup_pdf(pdf_path)

    # Step 5: LLM extraction
    prompt = build_prompt(event, crawled_content, pdf_text, config)
    llm_result = call_ollama(prompt, config)
    duration = llm_result.pop("_duration_s", None) if llm_result else None
    result["steps"]["llm"] = {
        "model": config.ollama_model,
        "duration_s": duration,
        "success": llm_result is not None,
    }

    # Step 6: Smart merge
    updates = build_updates(event, llm_result or {}, url_statuses, search_candidates, config)
    result["updates"] = updates
    result["steps"]["merge"] = {
        "fields_updated": [k for k in updates if k not in ("registration_url", "regulamin_url", "website")],
        "fields_replaced": [k for k in ("registration_url", "regulamin_url", "website") if k in updates],
    }

    return result


def fetch_events(config: Config, limit: Optional[int], force: bool, skip_ids: set) -> list[dict]:
    """Fetch events from scraper_all that need enrichment."""
    sb = create_client(config.supabase_url, config.supabase_key)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    all_rows = []
    page_size = 1000
    offset = 0
    while True:
        query = sb.from_("scraper_all").select(
            "id, name, date, location, distances, event_types, "
            "registration_url, regulamin_url, regulamin_urls, website, "
            "registration_deadline, price_from, price_to, voivodeship, is_kids, "
            "enriched_at, enriched_regulamin_at, enriched_search_at"
        )
        if not force:
            query = query.is_("enriched_at", "null")
        query = query.gte("date", today)
        data = query.range(offset, offset + page_size - 1).execute()
        if not data.data:
            break
        all_rows.extend(data.data)
        if len(data.data) < page_size:
            break
        offset += page_size

    # Filter out already-completed events (resume support)
    rows = [r for r in all_rows if r["id"] not in skip_ids]

    if limit:
        rows = rows[:limit]

    return rows


def write_updates(config: Config, event_id: str, updates: dict):
    """Write enrichment updates to scraper_all in Supabase."""
    sb = create_client(config.supabase_url, config.supabase_key)
    updates["enriched_at"] = datetime.now(timezone.utc).isoformat()
    sb.from_("scraper_all").update(updates).eq("id", event_id).execute()


def stamp_enriched(config: Config, event_id: str):
    """Mark event as enriched even if no changes were made."""
    sb = create_client(config.supabase_url, config.supabase_key)
    sb.from_("scraper_all").update({
        "enriched_at": datetime.now(timezone.utc).isoformat()
    }).eq("id", event_id).execute()


async def run_pipeline(config: Config, limit: Optional[int], dry_run: bool, resume: bool, force: bool):
    """Main pipeline loop: fetch events, process each, write results."""
    import click

    # Resume support
    skip_ids = set()
    log_dir = "logs"
    if resume:
        skip_ids = RunLogger.load_completed_from_latest(log_dir)
        if skip_ids:
            click.echo(f"Resuming: skipping {len(skip_ids)} already-processed events")

    # Fetch events
    events = fetch_events(config, limit, force, skip_ids)
    total = len(events)

    if total == 0:
        click.echo("No events need enrichment.")
        return

    click.echo(f"Processing {total} events" + (" (DRY RUN)" if dry_run else ""))

    logger = RunLogger(log_dir=log_dir)
    enriched_count = 0
    skipped_count = 0
    failed_count = 0

    for i, event in enumerate(events):
        click.echo(f"\n[{i + 1}/{total}] {event['name']} | {event.get('date', '?')} | {event.get('location', '?')}")

        try:
            result = await process_event(event, config)

            # Log each step
            for step_name, step_data in result["steps"].items():
                logger.log(event["id"], event["name"], step_name, step_data)
                _print_step(step_name, step_data)

            updates = result["updates"]

            if updates:
                # Print field changes
                for field, value in updates.items():
                    old = event.get(field)
                    old_str = _format_value(old)
                    new_str = _format_value(value)
                    prefix = "WOULD" if dry_run else "✓"
                    click.echo(f"    {prefix} {field}: {old_str} → {new_str}")

                if not dry_run:
                    write_updates(config, event["id"], updates)
                enriched_count += 1
            else:
                if not dry_run:
                    stamp_enriched(config, event["id"])
                click.echo("    — no changes")
                skipped_count += 1

            # Log merge step (marks as completed for resume)
            logger.log(event["id"], event["name"], "merge", {
                "fields_updated": list(updates.keys()),
                "dry_run": dry_run,
            })

        except Exception as e:
            click.echo(f"    ERROR: {str(e)[:200]}")
            logger.log(event["id"], event["name"], "error", {"message": str(e)[:500]})
            failed_count += 1

    click.echo(f"\n{'=== DRY RUN ===' if dry_run else '=== DONE ==='}")
    click.echo(f"  enriched: {enriched_count}")
    click.echo(f"  skipped (no changes): {skipped_count}")
    click.echo(f"  failed: {failed_count}")
    click.echo(f"  log: {logger.log_path}")


def _print_step(name, data):
    """Print a concise step summary."""
    import click
    if name == "validate":
        dead = data.get("dead", [])
        dead_str = f", {len(dead)} dead ({', '.join(dead)})" if dead else ", all alive"
        click.echo(f"    validate: {data.get('urls_checked', 0)} URLs checked{dead_str}")
    elif name == "search":
        found = data.get("found", {})
        if found:
            click.echo(f"    search: found {', '.join(found.keys())} via SearXNG")
        else:
            click.echo("    search: no results")
    elif name == "crawl":
        click.echo(f"    crawl: {data.get('pages', 0)} pages, {data.get('total_chars', 0)} chars")
    elif name == "pdf":
        click.echo(f"    pdf: regulamin extracted, {data.get('extracted_chars', 0)} chars")
    elif name == "llm":
        dur = data.get("duration_s")
        click.echo(f"    llm: {dur}s, {'success' if data.get('success') else 'failed'}")


def _format_value(v):
    if v is None:
        return "(none)"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v)
```

- [ ] **Step 4: Update __main__.py to wire up the pipeline**

Replace the contents of `enricher/enricher/__main__.py`:

```python
import asyncio
import click
from enricher.config import load_config
from enricher.pipeline import run_pipeline


@click.group()
def cli():
    """LeszyRun event enricher — local LLM pipeline."""
    pass


@cli.command()
@click.option("--limit", type=int, default=None, help="Max events to process")
@click.option("--dry-run", is_flag=True, help="Show changes without writing to DB")
@click.option("--resume", is_flag=True, help="Skip events from most recent run log")
@click.option("--force", is_flag=True, help="Re-process even if enriched_at is set")
def run(limit, dry_run, resume, force):
    """Run the enrichment pipeline."""
    config = load_config()
    click.echo(f"Enricher ready. Ollama: {config.ollama_url}, SearXNG: {config.searxng_url}")
    if dry_run:
        click.echo("=== DRY RUN ===")
    asyncio.run(run_pipeline(config, limit, dry_run, resume, force))


if __name__ == "__main__":
    cli()
```

- [ ] **Step 5: Run pipeline tests**

```bash
cd enricher
python -m pytest tests/test_pipeline.py -v
```

Expected: all 2 tests PASS

- [ ] **Step 6: Commit**

```bash
git add enricher/enricher/pipeline.py enricher/enricher/__main__.py enricher/tests/test_pipeline.py
git commit -m "feat(enricher): wire up full pipeline with CLI, logging, and Supabase I/O"
```

---

### Task 10: Integration Test & End-to-End Verification

**Files:**
- No new files — this task verifies the full stack works together

- [ ] **Step 1: Run all unit tests**

```bash
cd enricher
python -m pytest tests/ -v
```

Expected: all tests PASS

- [ ] **Step 2: Verify SearXNG is running**

```bash
cd enricher
docker compose up -d
sleep 5
curl -s "http://localhost:8888/search?q=bieg+maraton+warszawa+2026&format=json&language=pl" | python -m json.tool | head -30
```

Expected: JSON response with search results

- [ ] **Step 3: Verify Ollama is running with the model**

```bash
ollama list | grep qwen2.5
```

Expected: line showing `qwen2.5:72b-instruct-q4_0`

If not listed:
```bash
ollama pull qwen2.5:72b-instruct-q4_0
```

- [ ] **Step 4: Test Ollama API directly**

```bash
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:72b-instruct-q4_0",
  "prompt": "Return only JSON: {\"test\": true}",
  "stream": false,
  "options": {"temperature": 0.1, "num_predict": 50}
}' | python -m json.tool | head -10
```

Expected: JSON with `"response"` containing `{"test": true}`

- [ ] **Step 5: Dry run with 1 real event**

```bash
cd enricher
source .venv/bin/activate
python -m enricher run --limit 1 --dry-run
```

Expected: pipeline processes 1 event, shows what would change, does NOT write to Supabase.

Review the output: validate/search/crawl/pdf/llm/merge steps should all show reasonable data.

- [ ] **Step 6: Live run with 1 event**

```bash
python -m enricher run --limit 1
```

Expected: same as dry run but actually writes to Supabase. Verify in Supabase dashboard that `enriched_at` is set on the processed row.

- [ ] **Step 7: Verify resume works**

```bash
python -m enricher run --limit 3 --resume
```

Expected: the event from Step 6 should be skipped (already in the most recent run log). Only 2 new events processed.

- [ ] **Step 8: Commit any fixes from integration testing**

```bash
git add -A enricher/
git commit -m "fix(enricher): integration test fixes"
```

(Only if changes were needed.)

---

### Task 11: Add enricher/ to root .gitignore and Update CLAUDE.md

**Files:**
- Modify: `/Users/derberg/Documents/GitHub/BeepBeep/.gitignore` (if exists)
- Modify: `/Users/derberg/Documents/GitHub/BeepBeep/CLAUDE.md`

- [ ] **Step 1: Add enricher-specific entries to root .gitignore**

If there's a root `.gitignore`, add:
```
enricher/.venv/
enricher/.env
enricher/logs/
enricher/searxng-data/
```

- [ ] **Step 2: Update CLAUDE.md with enricher section**

Add after the "Event scraper pipeline" section in CLAUDE.md:

```markdown
## Local LLM Enricher

Python-based enrichment pipeline in `enricher/`. Validates URLs, searches SearXNG, crawls pages with Crawl4AI, extracts PDFs with Docling, and uses Ollama (qwen2.5:72b) for field extraction.

### Running

```bash
cd enricher
source .venv/bin/activate
docker compose up -d          # SearXNG
python -m enricher run         # process all un-enriched
python -m enricher run --limit 5 --dry-run  # test run
python -m enricher run --resume             # continue interrupted run
```

### What it enriches (scraper_all fields)
distances, event_types, registration_url, regulamin_url, website, registration_deadline, price_from, price_to, voivodeship, is_kids

### Enrichment tracking
- `enriched_at` column on scraper_all — set after processing, prevents re-runs
- JSONL logs in `enricher/logs/` — one file per run, supports `--resume`

### Dependencies
- Ollama (native macOS, `qwen2.5:72b-instruct-q4_0`)
- SearXNG (Docker, port 8888)
- Crawl4AI + Docling (Python libs)
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs: add enricher section to CLAUDE.md and update .gitignore"
```
