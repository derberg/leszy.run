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
