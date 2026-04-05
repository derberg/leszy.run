from datetime import datetime, timedelta, timezone
from typing import Optional

import click
from supabase import create_client

from enricher.config import Config

# Fields to sync from scraper_all → calendar_events
# Left = scraper_all column, Right = calendar_events column
SYNC_FIELDS = {
    "event_types": "event_type",       # array in both, different column name
    "distances": "distances",          # string in scraper_all → array in calendar_events
    "registration_url": "registration_url",
    "regulamin_url": "regulamin_url",
    "registration_deadline": "registration_deadline",
    "price_from": "price_from",
    "price_to": "price_to",
    "website": "website",
    "voivodeship": "voivodeship",
    "is_kids": None,                   # handled specially: merged into event_type as "dzieci"
}


def _parse_since(since: Optional[str]) -> Optional[str]:
    """Parse --since into an ISO datetime string."""
    if not since:
        return None
    now = datetime.now(timezone.utc)
    if since == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    if since == "yesterday":
        return (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    # Try as date
    try:
        return datetime.fromisoformat(since).replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


def _parse_distances(dist_str: str) -> list:
    """Convert comma-separated distances string to array."""
    if not dist_str or not dist_str.strip():
        return []
    return [d.strip() for d in dist_str.split(",") if d.strip()]


def sync_to_calendar(config: Config, since: Optional[str], dry_run: bool):
    """Push enriched fields from scraper_all to matching calendar_events rows."""
    sb = create_client(config.supabase_url, config.supabase_key)

    # Fetch enriched scraper_all rows
    query = sb.from_("scraper_all").select(
        "id, name, source, source_id, event_types, distances, "
        "registration_url, regulamin_url, registration_deadline, "
        "price_from, price_to, website, voivodeship, is_kids, enriched_at"
    ).not_.is_("enriched_at", "null")

    since_dt = _parse_since(since)
    if since_dt:
        query = query.gte("enriched_at", since_dt)
        click.echo(f"Syncing events enriched since {since_dt}")
    else:
        click.echo("Syncing ALL enriched events")

    # Paginate
    all_rows = []
    page_size = 1000
    offset = 0
    while True:
        data = query.range(offset, offset + page_size - 1).execute()
        if not data.data:
            break
        all_rows.extend(data.data)
        if len(data.data) < page_size:
            break
        offset += page_size

    click.echo(f"Found {len(all_rows)} enriched events in scraper_all")

    if not all_rows:
        return

    updated = 0
    skipped = 0
    not_found = 0
    errors = []

    for row in all_rows:
        # Find matching calendar_events row
        match = sb.from_("calendar_events").select("id, event_type, distances").eq(
            "source", row["source"]
        ).eq("source_id", row["source_id"]).execute()

        if not match.data:
            not_found += 1
            continue

        ce = match.data[0]
        updates = {}

        # event_types → event_type (with is_kids → "dzieci")
        if row.get("event_types"):
            new_types = list(row["event_types"])
            if row.get("is_kids") and "dzieci" not in new_types:
                new_types.append("dzieci")
            if set(new_types) != set(ce.get("event_type") or []):
                updates["event_type"] = new_types

        # distances: string → array
        if row.get("distances"):
            new_dists = _parse_distances(row["distances"])
            if new_dists and set(new_dists) != set(ce.get("distances") or []):
                updates["distances"] = new_dists

        # Simple fields: only update if scraper_all has a value
        for sa_field, ce_field in SYNC_FIELDS.items():
            if ce_field is None:
                continue  # is_kids handled above
            if sa_field in ("event_types", "distances"):
                continue  # handled above
            val = row.get(sa_field)
            if val is not None:
                updates[ce_field] = val

        # Mark enriched
        updates["enriched_at"] = row["enriched_at"]

        if not updates:
            skipped += 1
            continue

        prefix = "WOULD" if dry_run else "✓"
        click.echo(f"  {prefix} {row['name'][:60]:60s} | {', '.join(updates.keys())}")

        if not dry_run:
            try:
                sb.from_("calendar_events").update(updates).eq("id", ce["id"]).execute()
                updated += 1
            except Exception as e:
                errors.append(f"{row['name']}: {e}")
        else:
            updated += 1

    click.echo(f"\n{'=== DRY RUN ===' if dry_run else '=== DONE ==='}")
    click.echo(f"  updated: {updated}")
    click.echo(f"  skipped (no changes): {skipped}")
    click.echo(f"  not in calendar_events: {not_found}")
    if errors:
        click.echo(f"  errors: {len(errors)}")
        for e in errors:
            click.echo(f"    {e}")
