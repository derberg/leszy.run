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

    # Step 4: Extract from PDF regulamin (fallback to crawl if PDF download fails)
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
        elif regulamin_url:
            # PDF download failed (e.g. SPA wrapper serving HTML) — crawl it instead
            fallback = await crawl_pages({"regulamin_url": regulamin_url}, max_chars=config.max_page_chars)
            if fallback.get("regulamin_url"):
                crawled_content["regulamin_url"] = fallback["regulamin_url"].content
                result["steps"]["pdf"] = {"fallback_crawl": True, "extracted_chars": fallback["regulamin_url"].chars}

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
    had_content = bool(crawled_content or pdf_text)
    updates = build_updates(event, llm_result or {}, url_statuses, search_candidates, config, had_content)
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
        else:
            query = query.not_.is_("enriched_at", "null")
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
