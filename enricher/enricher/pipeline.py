import asyncio
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from supabase import create_client

from enricher.config import Config
from enricher.run_logger import RunLogger
from enricher.steps.validate_urls import validate_urls
from enricher.steps.search import search_missing_urls
from enricher.steps.crawl import crawl_pages, crawl_url_list
from enricher.steps.pdf import download_pdf, extract_pdf_text, cleanup_pdf
from enricher.steps.docs import extract_regulamin_doc

# Regulamin URL kinds handled outside the HTML crawler (binary files / Drive
# aggregator folders): a PDF goes through download_pdf, the rest through
# extract_regulamin_doc. Anything not in here is crawled as an HTML page.
_NON_CRAWL_KINDS = ("pdf", "docx", "drive_folder", "drive_file")
_DOC_KINDS = ("docx", "drive_folder", "drive_file")
from enricher.steps.llm import call_ollama, build_prompt
from enricher.steps.merge import build_updates
from enricher.steps.navigate import (
    pick_followup_urls, is_stub_host, page_matches_event, strip_foreign_event_lines,
)
from enricher.steps.regex_prepass import extract_hints


async def process_event(event: dict, config: Config) -> dict:
    """Process a single event through all enrichment steps. Returns result dict."""
    result = {"id": event["id"], "name": event["name"], "updates": {}, "steps": {}}

    # Step 1: Validate existing URLs (registration + regulamin only).
    url_fields = {
        k: event.get(k) for k in ["registration_url", "regulamin_url", "regulamin_urls"]
    }
    url_statuses = validate_urls(url_fields, timeout=config.url_timeout)
    result["steps"]["validate"] = {
        "urls_checked": len(url_statuses),
        "dead": [k for k, v in url_statuses.items() if v.status == "dead"],
        "url_map": {k: v for k, v in url_fields.items() if v},
        "is_pdf": [k for k, v in url_statuses.items() if v.is_pdf],
    }

    # Determine which URL fields are missing or dead
    missing = []
    working_urls = {}  # field → url (alive ones for crawling)

    for field in ["registration_url", "regulamin_url"]:
        url = event.get(field)
        status = url_statuses.get(field)
        if not url or (status and status.status == "dead"):
            missing.append(field)
        elif status:
            final = status.final_url or url
            working_urls[field] = final

    # Stub registration URLs (thin login shells) carry no real content, but
    # their subpages / linked PDFs often hold the regulamin. We crawl those
    # below to *discover the regulamin PDF*, not to harvest fields from them.
    stub_fields = []
    url = working_urls.get("registration_url")
    if url and is_stub_host(url) and "registration_url" not in missing:
        stub_fields.append("registration_url")

    # Step 2: Search for missing URLs (registration_url / regulamin_url only)
    search_candidates = {}
    search_queue = list(missing)

    if search_queue:
        search_candidates = search_missing_urls(event, search_queue, config)
        result["steps"]["search"] = {
            "queries": len(search_queue),
            "found": search_candidates,
        }
        for field, url in search_candidates.items():
            if field in missing:
                working_urls[field] = url

        # A regulamin found by search has no UrlStatus yet, so Step 4 wouldn't know
        # whether to download+extract it (pdf/docx/drive) or let Step 3 crawl it
        # (html). Validate the found URL so its `kind` is classified exactly like an
        # event-provided regulamin — this is what makes "search → enrich from the
        # regulamin" work for non-HTML regulamins too.
        searched_reg = search_candidates.get("regulamin_url")
        if searched_reg and "regulamin_url" not in url_statuses:
            reg_status = validate_urls({"regulamin_url": searched_reg}, timeout=config.url_timeout)
            if "regulamin_url" in reg_status:
                status = reg_status["regulamin_url"]
                url_statuses["regulamin_url"] = status
                working_urls["regulamin_url"] = status.final_url or searched_reg
                result["steps"]["search"]["regulamin_kind"] = status.kind

    # Step 3: Crawl web pages (exclude PDF regulamins)
    crawl_urls = {}
    for field, url in working_urls.items():
        if field == "regulamin_url":
            status = url_statuses.get("regulamin_url")
            if status and status.kind in _NON_CRAWL_KINDS:
                continue  # PDF / docx / Drive — handled in Step 4, not crawlable HTML
        crawl_urls[field] = url

    crawled = await crawl_pages(crawl_urls, max_chars=config.max_page_chars)
    crawled_content = {k: v.content for k, v in crawled.items() if v}
    skipped_pdf = [k for k in working_urls if k not in crawl_urls]
    result["steps"]["crawl"] = {
        "pages": len([v for v in crawled.values() if v]),
        "total_chars": sum(v.chars for v in crawled.values() if v),
        "skipped_pdf": skipped_pdf,
        "failed": [k for k, v in crawled.items() if not v],
    }

    # Step 3b: Navigate — for stubs and landing pages, follow keyword-matched
    # internal links and (when on a stub) the top external organizer link.
    # This is what rescues events where the "registration page" is a thin
    # login stub but the real content lives on subpages like "Opis Imprezy".
    followup_urls: list[str] = []
    followup_from_pdf_links: list[str] = []
    for field, url in crawl_urls.items():
        crawl_result = crawled.get(field)
        if not crawl_result:
            continue
        is_stub = is_stub_host(url)
        max_internal = 4 if is_stub else 3
        max_external = 1 if is_stub else 0
        picked = pick_followup_urls(
            base_url=crawl_result.url,
            internal_links=crawl_result.internal_links,
            external_links=crawl_result.external_links,
            max_internal=max_internal,
            max_external=max_external,
        )
        for u in picked:
            # Separate PDFs — they go through the PDF pipeline, not crawl
            if u.lower().endswith(".pdf"):
                if u not in followup_from_pdf_links:
                    followup_from_pdf_links.append(u)
            elif u not in followup_urls and u not in crawl_urls.values():
                followup_urls.append(u)

    # Cap followups globally to keep runtime bounded
    followup_urls = followup_urls[:5]
    followup_from_pdf_links = followup_from_pdf_links[:2]

    followup_crawled = {}
    if followup_urls:
        followup_crawled = await crawl_url_list(followup_urls, max_chars=config.max_page_chars)
        for url, cr in followup_crawled.items():
            if cr and cr.content:
                # Merge into crawled_content under a synthetic field key
                crawled_content[f"followup:{url}"] = cr.content
        result["steps"]["navigate"] = {
            "followed": len(followup_urls),
            "followup_urls": followup_urls,
            "pdf_candidates": len(followup_from_pdf_links),
            "pdf_candidate_urls": followup_from_pdf_links,
            "successful": len([v for v in followup_crawled.values() if v]),
        }

    # Step 4: Extract from PDF regulamin (primary, or from followup PDF links)
    pdf_text = None
    pdf_path = None
    regulamin_url = working_urls.get("regulamin_url")
    regulamin_status = url_statuses.get("regulamin_url")

    regulamin_kind = regulamin_status.kind if regulamin_status else None

    # Primary: current regulamin_url if it's a PDF
    if regulamin_url and regulamin_kind == "pdf":
        pdf_path = await download_pdf(regulamin_url)
        if pdf_path:
            pdf_text = extract_pdf_text(pdf_path, max_chars=config.max_pdf_chars)
            result["steps"]["pdf"] = {"source": "existing", "extracted_chars": len(pdf_text) if pdf_text else 0}
            cleanup_pdf(pdf_path)
        elif regulamin_url:
            fallback = await crawl_pages({"regulamin_url": regulamin_url}, max_chars=config.max_page_chars)
            if fallback.get("regulamin_url"):
                crawled_content["regulamin_url"] = fallback["regulamin_url"].content
                result["steps"]["pdf"] = {"source": "fallback_crawl", "extracted_chars": fallback["regulamin_url"].chars}

    # docx / Google Drive folder or file — extract text ourselves (the HTML crawler
    # would only see a binary blob or the Drive SPA shell). Feeds pdf_text, which
    # downstream treats as the authoritative regulamin document text.
    elif regulamin_url and regulamin_kind in _DOC_KINDS:
        pdf_text = await extract_regulamin_doc(regulamin_url, regulamin_kind, max_chars=config.max_pdf_chars)
        result["steps"]["pdf"] = {"source": f"doc:{regulamin_kind}", "extracted_chars": len(pdf_text) if pdf_text else 0}

    # Fallback: try PDFs discovered on crawled pages (often the real regulamin
    # is linked as a PDF from an aggregator stub page)
    if not pdf_text and followup_from_pdf_links:
        for pdf_url in followup_from_pdf_links:
            p = await download_pdf(pdf_url)
            if p:
                text = extract_pdf_text(p, max_chars=config.max_pdf_chars)
                cleanup_pdf(p)
                if text:
                    pdf_text = text
                    result["steps"]["pdf"] = {"source": "discovered", "url": pdf_url, "extracted_chars": len(text)}
                    # If we had no regulamin_url, offer this as a candidate
                    if not event.get("regulamin_url"):
                        search_candidates.setdefault("regulamin_url", pdf_url)
                    break

    # Step 3c: Clean crawled content before it reaches the regex pre-pass and the
    # LLM (both read crawled_content). Two guards:
    #   1. Relevance gate — a page found via SearXNG that doesn't actually
    #      describe this event (wrong-event hit, e.g. Ochabski → rundazubra.pl)
    #      is dropped, and its URL is not adopted as a field value.
    #   2. Foreign-event line stripping — remove "upcoming events" / sibling-race
    #      chrome (pomiaryczasu's "Najbliższe zawody") so other races' distances
    #      don't leak into extraction (IX Bieg Wolności → Pętla's 54/108 km).
    search_urls = {u for u in search_candidates.values() if u}
    self_urls = [
        working_urls.get("registration_url"), event.get("registration_url"),
        event.get("source_url"),
    ]

    def _host(u):
        try:
            return (urlparse(u).hostname or "").lower().removeprefix("www.")
        except Exception:
            return ""

    dropped_irrelevant = []
    dropped_hosts = set()
    for key in list(crawled_content.keys()):
        url = key.removeprefix("followup:") if key.startswith("followup:") else working_urls.get(key)
        if url and url in search_urls and not page_matches_event(event, crawled_content[key]):
            dropped_irrelevant.append(url)
            crawled_content.pop(key, None)
            if _host(url):
                dropped_hosts.add(_host(url))
            for f, cu in list(search_candidates.items()):
                if cu == url:
                    search_candidates.pop(f, None)
                    working_urls.pop(f, None)

    # A rejected search page's own subpages were crawled as followups (e.g.
    # rundazubra.pl/trasa carries the wrong event's 21 km). Drop everything from a
    # rejected host so those distances don't leak in through the followups.
    if dropped_hosts:
        for key in list(crawled_content.keys()):
            url = key.removeprefix("followup:") if key.startswith("followup:") else working_urls.get(key)
            if url and _host(url) in dropped_hosts:
                crawled_content.pop(key, None)
                if url not in dropped_irrelevant:
                    dropped_irrelevant.append(url)

    for key in list(crawled_content.keys()):
        crawled_content[key] = strip_foreign_event_lines(crawled_content[key], self_urls)

    result["steps"]["clean"] = {
        "dropped_irrelevant_search_pages": dropped_irrelevant,
    }

    # Field extraction reads the REGULAMIN ONLY — never the registration page,
    # website, or navigated followups. Those are used to FIND the regulamin (and
    # to confirm/replace URLs), but distances/prices/deadline/types/kids must
    # come from the rules document. The regulamin is either a downloaded PDF
    # (pdf_text) or, when it's an HTML page, crawled_content["regulamin_url"].
    regulamin_content = {}
    if crawled_content.get("regulamin_url"):
        regulamin_content["regulamin_url"] = crawled_content["regulamin_url"]

    # Step 4.5: Regex pre-pass — extract obvious prices/deadlines from regulamin
    prepass_texts = list(regulamin_content.values())
    if pdf_text:
        prepass_texts.append(pdf_text)
    hints = extract_hints(prepass_texts, event_date=event.get("date"))
    result["steps"]["prepass"] = {k: v for k, v in hints.items() if v is not None}

    # Step 5: LLM extraction (regulamin content only; scraper distances as anchors)
    prompt = build_prompt(event, regulamin_content, pdf_text, config, hints=hints)
    llm_result = call_ollama(prompt, config)
    duration = llm_result.pop("_duration_s", None) if llm_result else None
    result["steps"]["llm"] = {
        "model": config.ollama_model,
        "duration_s": duration,
        "success": llm_result is not None,
    }

    # Backfill LLM fields from regex hints when LLM missed them (never override
    # a concrete LLM value — the regex is a safety net, not authoritative).
    # Critically: this must run even when the LLM call FAILED (timed out, etc.)
    # — otherwise valid prepass hits like "70 zł / do dnia 24.09.2026" extracted
    # from the PDF get thrown away with the failed llm_result. Promote None to
    # an empty dict so the merge step sees the hints regardless.
    if llm_result is None:
        llm_result = {}
    for key in ("price_from", "price_to", "registration_deadline"):
        if llm_result.get(key) in (None, "") and hints.get(key) is not None:
            llm_result[key] = hints[key]

    # Step 6: Smart merge. had_content reflects whether we had REGULAMIN content
    # to read — that's what makes the LLM authoritative on event_types/is_kids.
    had_content = bool(regulamin_content or pdf_text)
    updates = build_updates(event, llm_result or {}, url_statuses, search_candidates, config, had_content)
    result["updates"] = updates
    result["steps"]["merge"] = {
        "fields_updated": [k for k in updates if k not in ("registration_url", "regulamin_url")],
        "fields_replaced": [k for k in ("registration_url", "regulamin_url") if k in updates],
    }

    return result


def _is_incomplete(row: dict) -> bool:
    """Return True if an enriched event is still missing at least one enrichable field.

    price_to alone does NOT count as missing: many events have a single flat fee, so
    we only flag it when combined with a missing price_from (which is already covered
    by the price_from check below).
    """
    if not row.get("registration_url"):
        return True
    if not row.get("regulamin_url"):
        return True
    if not row.get("registration_deadline"):
        return True
    if row.get("price_from") is None:
        return True
    if not row.get("voivodeship"):
        return True
    if row.get("is_kids") is None:
        return True
    if not row.get("distances"):
        return True
    if not row.get("event_types"):
        return True
    return False


def fetch_events(
    config: Config,
    limit: Optional[int],
    force: bool,
    incomplete: bool,
    skip_ids: set,
) -> list[dict]:
    """Fetch events from scraper_all that need enrichment."""
    sb = create_client(config.supabase_url, config.supabase_key)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    all_rows = []
    page_size = 1000
    offset = 0
    while True:
        query = sb.from_("scraper_all").select(
            "id, name, date, location, distances, event_types, "
            "registration_url, regulamin_url, regulamin_urls, "
            "registration_deadline, price_from, price_to, voivodeship, is_kids, "
            "enriched_at, enriched_regulamin_at, enriched_search_at"
        )
        if incomplete or force:
            query = query.not_.is_("enriched_at", "null")
        else:
            query = query.is_("enriched_at", "null")
        query = query.gte("date", today)
        data = query.range(offset, offset + page_size - 1).execute()
        if not data.data:
            break
        all_rows.extend(data.data)
        if len(data.data) < page_size:
            break
        offset += page_size

    # Narrow to events that still have gaps (client-side filter; can't express
    # the full predicate cleanly in a single PostgREST query).
    if incomplete:
        all_rows = [r for r in all_rows if _is_incomplete(r)]

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


async def run_pipeline(
    config: Config,
    limit: Optional[int],
    dry_run: bool,
    resume: bool,
    force: bool,
    incomplete: bool = False,
):
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
    events = fetch_events(config, limit, force, incomplete, skip_ids)
    total = len(events)

    if total == 0:
        click.echo("No events need enrichment.")
        return

    click.echo(f"Processing {total} events" + (" (DRY RUN)" if dry_run else ""))

    # Pre-warm the LLM: unload any other loaded models first so the swap is fast,
    # then load the enricher model with keep_alive=-1 so it stays resident.
    click.echo(f"Warming up LLM ({config.ollama_model})...")
    import httpx as _httpx
    try:
        with _httpx.Client(timeout=900) as _client:
            _client.post(
                f"{config.ollama_url}/api/generate",
                json={"model": config.ollama_model, "prompt": "hi", "stream": False,
                      "keep_alive": -1, "options": {"num_predict": 1, "num_ctx": 8192}},
            ).raise_for_status()
        click.echo("LLM ready.")
    except Exception as _e:
        click.echo(f"LLM warm-up failed: {_e} — aborting")
        return

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
            import httpx
            if isinstance(e, httpx.TimeoutException):
                click.echo("    LLM timed out — aborting run")
                break
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
        url_map = data.get("url_map", {})
        dead = set(data.get("dead", []))
        is_pdf = set(data.get("is_pdf", []))
        parts = []
        for field in ["registration_url", "regulamin_url"]:
            if field not in url_map:
                parts.append(f"{field}: (none)")
            elif field in dead:
                parts.append(f"{field}: dead")
            elif field in is_pdf:
                parts.append(f"{field}: PDF")
            else:
                parts.append(f"{field}: ok")
        click.echo(f"    validate: {' | '.join(parts)}")
    elif name == "search":
        found = data.get("found", {})
        if found:
            click.echo(f"    search: found {', '.join(found.keys())} via SearXNG")
        else:
            click.echo("    search: no results")
    elif name == "crawl":
        pages = data.get("pages", 0)
        chars = data.get("total_chars", 0)
        notes = []
        if data.get("skipped_pdf"):
            notes.append(f"PDF skipped: {', '.join(data['skipped_pdf'])}")
        if data.get("failed"):
            notes.append(f"failed: {', '.join(data['failed'])}")
        suffix = f" ({'; '.join(notes)})" if notes else ""
        click.echo(f"    crawl: {pages} pages, {chars} chars{suffix}")
    elif name == "navigate":
        successful = data.get("successful", 0)
        followed = data.get("followed", 0)
        pdf_candidates = data.get("pdf_candidates", 0)
        click.echo(
            f"    navigate: {successful}/{followed} followups crawled, "
            f"{pdf_candidates} pdf candidates"
        )
        for u in data.get("followup_urls", []):
            click.echo(f"      {u}")
        for u in data.get("pdf_candidate_urls", []):
            click.echo(f"      PDF: {u}")
    elif name == "pdf":
        src = data.get("source", "existing")
        url_note = f" ({data['url']})" if src == "discovered" and data.get("url") else ""
        click.echo(f"    pdf ({src}){url_note}: {data.get('extracted_chars', 0)} chars")
    elif name == "prepass":
        parts = []
        if data.get("price_from") is not None:
            parts.append(f"price {data['price_from']}-{data.get('price_to', data['price_from'])}")
        if data.get("registration_deadline"):
            parts.append(f"deadline {data['registration_deadline']}")
        if parts:
            click.echo(f"    prepass: {', '.join(parts)}")
    elif name == "llm":
        dur = data.get("duration_s")
        click.echo(f"    llm: {dur}s, {'success' if data.get('success') else 'failed'}")


def _format_value(v):
    if v is None:
        return "(none)"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v)
