"""Foxter-scoped enrichment backfill — reuses the exact production pipeline
(process_event + write_updates) but ONLY over foxter rows in scraper_all,
instead of the ~600 events `--incomplete` would sweep.

Default = DRY RUN (no DB writes): prints what each event WOULD get.
Pass --write to actually update scraper_all. --limit N caps the count.

Run inside the enricher container so SearXNG/Ollama/crawl4ai/pypdf are all wired:
  docker compose --profile run-once run --rm \
    -v "$PWD/enricher/foxter_backfill.py:/app/foxter_backfill.py" \
    enricher python /app/foxter_backfill.py --dry-run --limit 6
"""
import asyncio
import sys
from datetime import datetime, timezone

import click
import httpx
from supabase import create_client

from enricher.config import load_config
from enricher.pipeline import process_event, write_updates, stamp_enriched, _is_incomplete

_COLS = (
    "id, name, date, location, distances, event_types, "
    "registration_url, regulamin_url, regulamin_urls, website, "
    "registration_deadline, price_from, price_to, voivodeship, is_kids, "
    "enriched_at, enriched_regulamin_at, enriched_search_at"
)


def fetch_foxter(config):
    sb = create_client(config.supabase_url, config.supabase_key)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows, offset, page = [], 0, 1000
    while True:
        q = (sb.from_("scraper_all").select(_COLS)
             .eq("source", "foxter")
             .gte("date", today))
        data = q.range(offset, offset + page - 1).execute()
        if not data.data:
            break
        rows.extend(data.data)
        if len(data.data) < page:
            break
        offset += page
    # Only rows still missing an enrichable field (same predicate as --incomplete)
    return [r for r in rows if _is_incomplete(r)]


async def main(dry_run: bool, limit):
    config = load_config()
    events = fetch_foxter(config)
    if limit:
        events = events[:limit]
    click.echo(f"Foxter incomplete future events: {len(events)}"
               + (" (DRY RUN)" if dry_run else ""))
    if not events:
        return

    # Warm the model (same as run_pipeline)
    with httpx.Client(timeout=900) as c:
        c.post(f"{config.ollama_url}/api/generate",
               json={"model": config.ollama_model, "prompt": "hi", "stream": False,
                     "keep_alive": -1, "options": {"num_predict": 1, "num_ctx": 8192}}).raise_for_status()
    click.echo("LLM ready.\n")

    FIELDS = ("price_from", "price_to", "registration_deadline", "distances", "event_types", "website")
    enriched = 0
    for i, ev in enumerate(events):
        click.echo(f"[{i+1}/{len(events)}] {ev['name']} | {ev.get('date')}")
        try:
            result = await process_event(ev, config)
        except httpx.TimeoutException:
            click.echo("    LLM timed out — aborting"); break
        except Exception as e:
            click.echo(f"    ERROR: {str(e)[:160]}"); continue
        updates = result["updates"]
        recovered = {k: updates[k] for k in FIELDS if k in updates}
        if recovered:
            for k, v in recovered.items():
                click.echo(f"    {'WOULD' if dry_run else '✓'} {k}: {ev.get(k)} → {v}")
            if not dry_run:
                write_updates(config, ev["id"], updates)
            enriched += 1
        else:
            if not dry_run:
                stamp_enriched(config, ev["id"])
            click.echo("    — no new fields")
    click.echo(f"\n{'DRY RUN' if dry_run else 'DONE'}: {enriched}/{len(events)} got new fields")


if __name__ == "__main__":
    dry = "--write" not in sys.argv
    lim = None
    if "--limit" in sys.argv:
        lim = int(sys.argv[sys.argv.index("--limit") + 1])
    asyncio.run(main(dry_run=dry, limit=lim))
