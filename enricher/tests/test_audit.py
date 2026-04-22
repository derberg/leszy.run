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


def test_load_seen_pairs_reads_jsonl():
    from enricher.audit import load_seen_pairs, AuditReportLine, open_report, write_report_line
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "audit.jsonl")
        with open_report(path) as f:
            for i, v in enumerate(["match", "mismatch"]):
                write_report_line(f, AuditReportLine(
                    event_id=f"e{i}", event_name="E", event_date="2026-05-10",
                    event_location="", event_voivodeship="", field="website",
                    url=f"https://x{i}.pl", final_url="", verdict=v,
                    confidence=0.9, path="fast", reasoning="r", evidence={},
                    checked_at="2026-04-22T10:00:00+00:00",
                ))
        seen = load_seen_pairs(path)
        assert seen == {("e0", "website"), ("e1", "website")}


def test_load_seen_pairs_missing_file_returns_empty():
    from enricher.audit import load_seen_pairs
    assert load_seen_pairs("/nonexistent/path.jsonl") == set()


def test_load_seen_pairs_ignores_malformed_lines():
    from enricher.audit import load_seen_pairs
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "audit.jsonl")
        with open(path, "w") as f:
            f.write('{"event_id":"e1","field":"website"}\n')
            f.write("not json\n")
            f.write("\n")
            f.write('{"event_id":"e2","field":"website"}\n')
        seen = load_seen_pairs(path)
        assert seen == {("e1", "website"), ("e2", "website")}


def test_find_latest_report_picks_most_recent():
    from enricher.audit import find_latest_report
    import time as _time
    with tempfile.TemporaryDirectory() as d:
        p1 = os.path.join(d, "audit-a.jsonl")
        p2 = os.path.join(d, "audit-b.jsonl")
        with open(p1, "w") as f:
            f.write("")
        _time.sleep(0.02)
        with open(p2, "w") as f:
            f.write("")
        assert find_latest_report(d) == p2


def test_find_latest_report_none_when_empty():
    from enricher.audit import find_latest_report
    with tempfile.TemporaryDirectory() as d:
        assert find_latest_report(d) is None


def test_process_url_full_crawl_timeout_produces_error_verdict():
    from enricher.steps.audit_fetch import FastPage
    import enricher.audit as audit_mod

    page = FastPage(
        url="https://x.pl", final_url="https://x.pl", status="ok", http_status=200,
        title="Hi", body_sample="short",
    )

    async def _hang(*args, **kwargs):
        await asyncio.sleep(10)

    with patch("enricher.audit.fetch_fast", return_value=page), \
         patch("enricher.audit.crawl_pages", new=_hang), \
         patch.object(audit_mod, "FULL_CRAWL_TIMEOUT_SECONDS", 0.1):
        line = asyncio.run(process_url(
            event=_event(), field="website", url="https://x.pl",
            config=_cfg(), confidence_threshold=0.8,
        ))

    assert line.verdict == "error"
    assert line.path == "full"
    assert "timeout" in line.reasoning.lower()
