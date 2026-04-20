"""Audit command: review website URLs on calendar_events for correctness.

Read-only against the DB. Writes a JSONL report to enricher/logs/audit-<ts>.jsonl.
"""
import json as _json
import os
from collections import Counter
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone, timedelta
from typing import Iterable, Optional

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
    import click
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


def fetch_audit_events(config, since: str, fields: list) -> list:
    """Fetch future calendar_events rows that have at least one of `fields` populated."""
    from supabase import create_client
    sb = create_client(config.supabase_url, config.supabase_key)

    all_rows: list = []
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
    config,
    since: str,
    fields: list,
    limit: Optional[int],
    confidence_threshold: float,
    log_dir: str = "logs",
) -> str:
    """Run the audit over all matching events. Returns report path."""
    import click
    events = fetch_audit_events(config, since, fields)
    if limit:
        events = events[:limit]

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    report_path = os.path.join(log_dir, f"audit-{ts}.jsonl")

    click.echo(f"Auditing {len(events)} events for fields={fields} since={since}")
    click.echo(f"Report: {report_path}\n")

    verdicts: list = []
    mismatches: list = []

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
