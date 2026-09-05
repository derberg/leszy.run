"""Audit command: review website URLs on calendar_events for correctness.

Read-only against the DB. Writes a JSONL report to enricher/logs/audit-<ts>.jsonl.
"""
import asyncio
import glob
import json as _json
import os
from collections import Counter, deque
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone, timedelta
from typing import Iterable, Optional

from enricher.steps.audit_fetch import fetch_fast, FastPage
from enricher.steps.audit_prompt import build_fast_prompt, build_full_prompt
from enricher.steps.audit_verdict import call_audit_llm, AuditVerdict
from enricher.steps.crawl import crawl_pages
from enricher.steps.verify import url_slug_matches_event
from enricher.steps.navigate import is_social_host


FAST_PATH_MIN_TITLE_CHARS = 10
FAST_PATH_MIN_BODY_CHARS = 500
FAST_PATH_BODY_SAMPLE_CHARS = 2000
FULL_CRAWL_TIMEOUT_SECONDS = 300

# DNS-storm guard: if more than STORM_THRESHOLD of the last STORM_WINDOW fetches
# died with a DNS-shaped error, abort the run so we don't silently rack up false
# skipped_dead verdicts. Typically indicates macOS mDNSResponder has wedged.
DNS_STORM_WINDOW = 40
DNS_STORM_THRESHOLD = 0.25  # abort once >25% of recent fetches are DNS-dead
_DNS_ERROR_HINTS_LOWER = (
    "nodename nor servname",
    "getaddrinfo",
    "temporary failure in name resolution",
    "name or service not known",
)


def _is_dns_dead(line: "AuditReportLine") -> bool:
    if line.verdict != "skipped_dead":
        return False
    err = (line.evidence.get("error", "") if isinstance(line.evidence, dict) else "").lower()
    return any(h in err for h in _DNS_ERROR_HINTS_LOWER)

# File-share hosts that are never valid as an event `website`.
# They may legitimately appear as regulamin_url / registration_url (hosted PDFs, forms),
# so the blacklist is gated to field == "website" only.
WEBSITE_BLACKLIST_HOSTS = (
    "dropbox.com",
    "drive.google.com",
    "docs.google.com",
    "wetransfer.com",
)


def _host_matches_blacklist(url: str, hosts: tuple) -> bool:
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    for bad in hosts:
        if host == bad or host.endswith("." + bad):
            return True
    return False




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

    # 1b. Hard mismatch for file-share hosts on the website field.
    # Dropbox / Drive / WeTransfer links are never legitimate "official event websites"
    # even if the page is reachable — so we short-circuit with a high-confidence
    # mismatch so --apply nulls them.
    if field == "website" and _host_matches_blacklist(url, WEBSITE_BLACKLIST_HOSTS):
        return _make_line(
            event, field, url,
            verdict="mismatch", confidence=1.0, path="none",
            reasoning="File-share host is not a valid event website.",
            evidence={"host": url, "blacklist": "website"},
        )

    # 2. Fast path fetch
    page = fetch_fast(url, timeout=config.url_timeout, body_chars=FAST_PATH_BODY_SAMPLE_CHARS)
    if page is None or page.status == "dead":
        http_status = page.http_status if page else 0
        err = (page.error if page else "") or ""
        # HTTP 4xx means the server responded — the URL itself is wrong (page deleted,
        # moved, unauthorized) — so treat it as a high-confidence mismatch so --apply
        # can null the field. 5xx / DNS / SSL / timeouts stay as skipped_dead because
        # they're transient or ambiguous.
        if 400 <= http_status < 500:
            return _make_line(
                event, field, url,
                verdict="mismatch", confidence=1.0, path="none",
                reasoning=f"HTTP {http_status} — URL no longer serves this event.",
                evidence={"http_status": http_status, "error": err},
                final_url=(page.final_url if page else ""),
            )
        # Non-HTML response on the website field (e.g. a regulamin PDF stuck in the
        # website column) — the URL is alive but not a valid website. PDFs ARE
        # legitimate for regulamin_url / registration_url, so only mismatch for website.
        if field == "website" and err == "non-html content":
            return _make_line(
                event, field, url,
                verdict="mismatch", confidence=1.0, path="none",
                reasoning="URL returns non-HTML content (likely a PDF) — not a valid event website.",
                evidence={"http_status": http_status, "error": err},
                final_url=(page.final_url if page else ""),
            )
        # DNS failed locally AND was confirmed NXDOMAIN against 1.1.1.1 — the
        # domain is globally dead. Promote to mismatch so --apply nulls the URL.
        if page is not None and getattr(page, "nxdomain_confirmed", False):
            return _make_line(
                event, field, url,
                verdict="mismatch", confidence=1.0, path="none",
                reasoning="Domain is NXDOMAIN (confirmed via 1.1.1.1) — URL cannot resolve globally.",
                evidence={"http_status": http_status, "error": err, "nxdomain_confirmed": True},
                final_url=(page.final_url if page else ""),
            )
        return _make_line(
            event, field, url,
            verdict="skipped_dead", confidence=1.0, path="none",
            reasoning=f"URL is not reachable: {err or 'unknown error'}",
            evidence={"http_status": http_status, "error": err},
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

    # 4. Full path fallback: Crawl4AI, guarded by a hard timeout so a page that
    # never reaches networkidle cannot stall the whole audit run.
    try:
        crawl_map = await asyncio.wait_for(
            crawl_pages({"url": url}, max_chars=config.max_page_chars),
            timeout=FULL_CRAWL_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return _make_line(
            event, field, url,
            verdict="error", confidence=0.0, path="full",
            reasoning=f"Full-path crawl exceeded {FULL_CRAWL_TIMEOUT_SECONDS}s timeout.",
            evidence=_fast_evidence(page),
            final_url=page.final_url,
        )
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

    # Rescue uncertain verdicts with a URL-slug heuristic. If the URL's host/path
    # contains enough tokens from the event name (e.g. "Kołobrzeska Odyseja" at
    # kolobrzeskaodyseja.pl), treat it as a soft match — the LLM's content-only
    # reasoning is overly cautious about unproven editions / years.
    final_verdict = full_verdict.verdict
    final_confidence = full_verdict.confidence
    slug_note = ""
    if full_verdict.verdict == "uncertain" and url_slug_matches_event(url, event):
        final_verdict = "match"
        final_confidence = max(full_verdict.confidence, 0.75)
        slug_note = " (promoted via URL-slug match)"

    return _make_line(
        event, field, url,
        verdict=final_verdict,
        confidence=final_confidence,
        path="full",
        reasoning=full_verdict.reasoning + slug_note,
        evidence={
            **_fast_evidence(page),
            "crawled_chars": len(crawled_content or ""),
            "slug_match_promoted": bool(slug_note),
        },
        final_url=page.final_url,
    )


def open_report(path: str, mode: str = "w"):
    """Open a JSONL report file for writing. Ensures parent dir exists."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    return open(path, mode, encoding="utf-8")


def find_latest_report(log_dir: str) -> Optional[str]:
    """Return the path to the most recent audit-*.jsonl in log_dir, or None."""
    matches = glob.glob(os.path.join(log_dir, "audit-*.jsonl"))
    if not matches:
        return None
    return max(matches, key=os.path.getmtime)


def load_seen_pairs(report_path: str) -> set:
    """Read an existing audit JSONL and return {(event_id, field), ...} already processed."""
    seen: set = set()
    if not os.path.exists(report_path):
        return seen
    with open(report_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = _json.loads(line)
            except _json.JSONDecodeError:
                continue
            eid = obj.get("event_id")
            fname = obj.get("field")
            if eid and fname:
                seen.add((eid, fname))
    return seen


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
    select_cols = "id, name, date, location, voivodeship, distances, event_type, status, website, registration_url, regulamin_url, locked_fields, source, source_id"
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
    resume: bool = False,
    apply: bool = False,
    apply_confidence: float = 0.8,
    keep_uncertain: bool = False,
) -> str:
    """Run the audit over all matching events. Returns report path.

    When `resume=True`, continue the most recent audit-*.jsonl in log_dir:
    skip any (event_id, field) pair already present, and append new lines
    to that same file so the run ends up in one consolidated report.

    When `apply=True`, any `mismatch` verdict with confidence >=
    `apply_confidence` causes the corresponding field on calendar_events to
    be set to NULL. All other verdicts leave the DB untouched.
    """
    import click
    events = fetch_audit_events(config, since, fields)
    if limit:
        events = events[:limit]

    seen: set = set()
    report_mode = "w"
    report_path: str
    if resume:
        latest = find_latest_report(log_dir)
        if latest:
            seen = load_seen_pairs(latest)
            report_path = latest
            report_mode = "a"
            click.echo(f"Resuming from {latest}: {len(seen)} (event, field) pairs already processed")
        else:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            report_path = os.path.join(log_dir, f"audit-{ts}.jsonl")
            click.echo("No prior audit log found — starting fresh")
    else:
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        report_path = os.path.join(log_dir, f"audit-{ts}.jsonl")

    sb = None
    if apply:
        from supabase import create_client
        sb = create_client(config.supabase_url, config.supabase_key)
        click.echo(f"APPLY mode: mismatches with confidence >= {apply_confidence} will be nulled on calendar_events AND scraper_all")

    # Count how many (event, field) pairs actually need checking — so the progress
    # counter is meaningful during --resume (otherwise the first printed line reads
    # [68/634] because 67 prior events had no unprocessed pairs).
    pending_total = 0
    for ev in events:
        for fname in fields:
            if ev.get(fname) and (ev.get("id"), fname) not in seen:
                pending_total += 1

    click.echo(f"Auditing {len(events)} events for fields={fields} since={since}")
    click.echo(f"Pending checks: {pending_total}")
    click.echo(f"Report: {report_path}\n")

    verdicts: list = []
    mismatches: list = []
    nulled_count = 0
    nulled_scraper_all_count = 0
    skipped_locked_count = 0
    apply_errors: list = []
    done = 0

    # DNS-storm guard state
    dns_window: deque = deque(maxlen=DNS_STORM_WINDOW)
    storm_aborted = False

    with open_report(report_path, mode=report_mode) as rf:
        for ev in events:
            if storm_aborted:
                break
            for fname in fields:
                url = ev.get(fname)
                if not url:
                    continue
                if (ev.get("id"), fname) in seen:
                    continue
                done += 1
                click.echo(f"[{done}/{pending_total}] {ev.get('name', '')} | {fname} | {url[:80]}")
                line = await process_url(ev, fname, url, config, confidence_threshold)
                write_report_line(rf, line)
                verdicts.append(line.verdict)

                # DNS-storm check: track window of DNS-dead results; abort if too high.
                dns_window.append(1 if _is_dns_dead(line) else 0)
                if len(dns_window) == DNS_STORM_WINDOW:
                    dns_rate = sum(dns_window) / DNS_STORM_WINDOW
                    if dns_rate > DNS_STORM_THRESHOLD:
                        click.echo("\n" + "=" * 60)
                        click.echo(f"ABORT: DNS-storm detected — {int(dns_rate * 100)}% "
                                   f"of the last {DNS_STORM_WINDOW} fetches failed DNS.")
                        click.echo("Your local DNS resolver (macOS mDNSResponder?) is "
                                   "probably wedged. Continuing would record false "
                                   "skipped_dead verdicts.")
                        click.echo("Fix: try `sudo killall -HUP mDNSResponder` or "
                                   "restart networking, then:")
                        click.echo(f"   python -m enricher audit --apply --resume")
                        click.echo("=" * 60 + "\n")
                        storm_aborted = True
                        break
                click.echo(f"    verdict={line.verdict} conf={line.confidence:.2f} path={line.path}")
                # `uncertain` is treated like `mismatch` for --apply purposes unless
                # --keep-uncertain was passed — operationally, "uncertain but can't
                # confirm" is indistinguishable from "wrong" for a public calendar.
                # The slug-match heuristic already rescues obviously-right URLs to
                # `match`, so what stays uncertain is genuinely ambiguous.
                nullable = line.verdict == "mismatch" or (
                    line.verdict == "uncertain" and not keep_uncertain
                )
                if nullable:
                    mismatches.append((line.confidence, line))
                    # For uncertain we bypass the confidence floor (their confidence
                    # signals uncertainty, not conviction). For mismatch we still
                    # require `apply_confidence` to avoid nulling weak calls.
                    pass_conf = line.verdict == "uncertain" or line.confidence >= apply_confidence
                    if apply and sb is not None and pass_conf:
                        # Respect locked_fields: if an admin has locked this field
                        # on calendar_events (manual correction), never auto-null it.
                        locked = ev.get("locked_fields") or []
                        if fname in locked:
                            skipped_locked_count += 1
                            click.echo(f"    → SKIPPED (locked) {fname} on {line.event_id}")
                            continue
                        try:
                            sb.from_("calendar_events").update({fname: None}).eq("id", line.event_id).execute()
                            nulled_count += 1
                            click.echo(f"    → NULLED {fname} on calendar_events {line.event_id}")
                        except Exception as e:
                            apply_errors.append(f"{line.event_name} / {fname} (calendar_events): {e}")
                            click.echo(f"    → APPLY FAILED (calendar_events): {e}")

                        src = ev.get("source")
                        sid = ev.get("source_id")
                        if src and sid:
                            try:
                                sa_res = (
                                    sb.from_("scraper_all")
                                    .update({fname: None})
                                    .eq("source", src)
                                    .eq("source_id", sid)
                                    .eq(fname, url)
                                    .execute()
                                )
                                sa_rows = len(sa_res.data or [])
                                if sa_rows:
                                    nulled_scraper_all_count += sa_rows
                                    click.echo(f"    → NULLED {fname} on scraper_all ({src}/{sid})")
                            except Exception as e:
                                apply_errors.append(f"{line.event_name} / {fname} (scraper_all): {e}")
                                click.echo(f"    → APPLY FAILED (scraper_all): {e}")

    counts = summarize_verdicts(verdicts)
    click.echo("\n=== Audit done ===")
    click.echo(f"events checked: {len(events)}")
    click.echo(f"checks performed: {len(verdicts)}")
    click.echo("verdicts:")
    for k, v in counts.items():
        click.echo(f"  {k:<16} {v}")
    click.echo(f"\nreport: {report_path}")

    if apply:
        click.echo(f"\napply: nulled {nulled_count} fields on calendar_events")
        click.echo(f"apply: nulled {nulled_scraper_all_count} fields on scraper_all")
        if skipped_locked_count:
            click.echo(f"apply: skipped {skipped_locked_count} locked_fields entries")
        if apply_errors:
            click.echo(f"apply errors: {len(apply_errors)}")
            for err in apply_errors[:10]:
                click.echo(f"  {err}")

    if mismatches:
        click.echo("\ntop 10 mismatches:")
        mismatches.sort(key=lambda t: -t[0])
        for conf, line in mismatches[:10]:
            click.echo(f"  [{conf:.2f}] {line.event_name} / {line.url}")
            click.echo(f"         {line.reasoning[:160]}")

    return report_path
