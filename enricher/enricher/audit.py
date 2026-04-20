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
