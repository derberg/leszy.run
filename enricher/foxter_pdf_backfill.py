"""Foxter PDF-ONLY price/deadline/distance backfill.

Unlike the full pipeline, this does NOT do web search or crawl (that's the step
that pulled a payday-loan site and conflated kids/adult events). It reads ONLY
each event's own regulamin PDF, runs the same regex pre-pass + LLM, and fills
ONLY currently-empty fields (price_from, price_to, registration_deadline,
distances). It never overwrites a value that's already set.

Default = DRY RUN. Pass --write to update scraper_all. --limit N caps count.

Run in the enricher container:
  docker compose --profile run-once run --rm \
    -v "$PWD/enricher/foxter_pdf_backfill.py:/app/enricher/foxter_pdf_backfill.py" \
    enricher python foxter_pdf_backfill.py --dry-run --limit 8
"""
import asyncio
import sys
from datetime import datetime, timezone, date as _date

import click
import httpx
from supabase import create_client

from enricher.config import load_config
from enricher.steps.pdf import download_pdf, extract_pdf_text, cleanup_pdf
from enricher.steps.regex_prepass import extract_hints
from enricher.steps.llm import build_prompt, call_ollama

_COLS = ("id, name, date, location, distances, event_types, registration_url, "
        "regulamin_url, regulamin_urls, website, registration_deadline, "
        "price_from, price_to, voivodeship, is_kids")


def _empty(v):
    return v is None or v == "" or (isinstance(v, list) and not v)


def fetch_foxter(config, limit):
    sb = create_client(config.supabase_url, config.supabase_key)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows, off = [], 0
    while True:
        data = (sb.from_("scraper_all").select(_COLS)
                .eq("source", "foxter").gte("date", today)
                .range(off, off + 999).execute())
        if not data.data:
            break
        rows.extend(data.data)
        if len(data.data) < 1000:
            break
        off += 1000
    # only rows that have a regulamin AND are missing price or deadline
    rows = [r for r in rows if r.get("regulamin_url")
            and (_empty(r.get("price_from")) or _empty(r.get("registration_deadline")))]
    return rows[:limit] if limit else rows


def _valid_deadline(d, event_date):
    try:
        dd = _date.fromisoformat(d)
        ev = _date.fromisoformat(event_date)
    except (ValueError, TypeError):
        return False
    # within a year before the event, not after it
    return (ev.toordinal() - 366) <= dd.toordinal() <= ev.toordinal()


def write_updates(config, event_id, updates):
    sb = create_client(config.supabase_url, config.supabase_key)
    updates["enriched_regulamin_at"] = datetime.now(timezone.utc).isoformat()
    sb.from_("scraper_all").update(updates).eq("id", event_id).execute()


async def main(dry_run, limit):
    config = load_config()
    events = fetch_foxter(config, limit)
    click.echo(f"Foxter rows w/ regulamin + missing price/deadline: {len(events)}"
               + (" (DRY RUN)" if dry_run else ""))
    if not events:
        return
    with httpx.Client(timeout=900) as c:
        c.post(f"{config.ollama_url}/api/generate",
               json={"model": config.ollama_model, "prompt": "hi", "stream": False,
                     "keep_alive": -1, "options": {"num_predict": 1, "num_ctx": 8192}}).raise_for_status()
    click.echo("LLM ready.\n")

    filled = 0
    for i, ev in enumerate(events):
        click.echo(f"[{i+1}/{len(events)}] {ev['name']} | {ev.get('date')}")
        # Only skip DEDICATED kids-only listings (by name) — those sometimes point
        # at a different event's regulamin, so a PDF read bleeds the wrong data.
        # A normal race that merely HAS a kids category (is_kids=true) is one event
        # for both audiences; its regulamin is correct, so we process it normally.
        import re as _re
        if _re.search(r"dzieci|m[łl]odzie[żz]|greatkids|\bkids\b", ev.get("name", ""), _re.I):
            click.echo("    skip: dedicated kids-only listing (regulamin may belong to another event)"); continue
        path = await download_pdf(ev["regulamin_url"])
        if not path:
            click.echo("    skip: regulamin not downloadable"); continue
        pdf_text = extract_pdf_text(path, max_chars=config.max_pdf_chars)
        cleanup_pdf(path)
        if not pdf_text:
            click.echo("    skip: PDF has no text layer (image-only → needs OCR)"); continue

        hints = extract_hints([pdf_text], event_date=ev.get("date"))
        # build_prompt with ONLY the PDF (crawled={}) — no web content at all
        prompt = build_prompt(ev, {}, pdf_text, config, hints=hints)
        llm = call_ollama(prompt, config) or {}
        # regex backfill when LLM missed
        for k in ("price_from", "price_to", "registration_deadline"):
            if llm.get(k) in (None, "") and hints.get(k) is not None:
                llm[k] = hints[k]

        updates = {}
        pf, pt = llm.get("price_from"), llm.get("price_to")
        if _empty(ev.get("price_from")) and isinstance(pf, (int, float)) and 0 <= pf <= 2000:
            if pt is None or not isinstance(pt, (int, float)) or pt < pf:
                pt = pf
            if pt <= 2000:
                updates["price_from"] = int(pf)
                updates["price_to"] = int(pt)
        dl = llm.get("registration_deadline")
        if _empty(ev.get("registration_deadline")) and dl and _valid_deadline(dl, ev.get("date")):
            updates["registration_deadline"] = dl
        dist = llm.get("distances")
        if _empty(ev.get("distances")) and isinstance(dist, list) and dist:
            updates["distances"] = ", ".join(str(x) for x in dist)

        if updates:
            for k, v in updates.items():
                click.echo(f"    {'WOULD' if dry_run else '✓'} {k}: {ev.get(k)} → {v}")
            if not dry_run:
                write_updates(config, ev["id"], updates)
            filled += 1
        else:
            click.echo("    — nothing new from PDF")
    click.echo(f"\n{'DRY RUN' if dry_run else 'DONE'}: {filled}/{len(events)} got price/deadline/distance")


if __name__ == "__main__":
    dry = "--write" not in sys.argv
    lim = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    asyncio.run(main(dry_run=dry, limit=lim))
