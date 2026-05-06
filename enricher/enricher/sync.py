import json
import os
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


def _fmt(val) -> str:
    """Format a value for display."""
    if val is None:
        return "(empty)"
    if isinstance(val, list):
        return ", ".join(str(x) for x in val) if val else "(empty)"
    return str(val)


def filter_locked_fields(updates: dict, locked) -> dict:
    """Remove keys present in `locked` from `updates`.

    `enriched_at` is always preserved so the sync can still stamp completion.
    """
    if not locked:
        return updates
    locked_set = set(locked or [])
    return {
        k: v for k, v in updates.items()
        if k == "enriched_at" or k not in locked_set
    }


def sync_to_calendar(config: Config, since: Optional[str], dry_run: bool):
    """Push enriched fields from scraper_all to matching calendar_events rows."""
    started_at = datetime.now(timezone.utc).isoformat()
    sb = create_client(config.supabase_url, config.supabase_key)

    # Fetch enriched scraper_all rows.
    # A row is "enriched" if EITHER enriched_at (python pipeline) OR
    # enriched_search_at (run-enrich-search.js Claude fallback) is set.
    # Using only enriched_at silently dropped rows that had been search-enriched
    # but not yet python-enriched — caused 13 events to never reach
    # calendar_events on 2026-05-05 until we manually bumped enriched_at.
    query = sb.from_("scraper_all").select(
        "id, name, date, source, source_id, event_types, distances, "
        "registration_url, regulamin_url, registration_deadline, "
        "price_from, price_to, website, voivodeship, is_kids, "
        "enriched_at, enriched_search_at"
    ).or_("enriched_at.not.is.null,enriched_search_at.not.is.null")

    since_dt = _parse_since(since)
    if since_dt:
        # PostgREST OR: at least one of the two timestamps must be ≥ since_dt
        query = query.or_(
            f"enriched_at.gte.{since_dt},enriched_search_at.gte.{since_dt}"
        )
        click.echo(f"Syncing events enriched since {since_dt} (either pipeline)")
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
    updated_events = []
    not_found_events = []

    for row in all_rows:
        # Find matching calendar_events row — try source+source_id first, fallback to name+date
        ce_fields = (
            "id, event_type, distances, registration_url, regulamin_url, "
            "registration_deadline, price_from, price_to, website, voivodeship, enriched_at, locked_fields"
        )
        match = sb.from_("calendar_events").select(ce_fields).eq(
            "source", row["source"]
        ).eq("source_id", row["source_id"]).execute()

        if not match.data and row.get("name") and row.get("date"):
            match = sb.from_("calendar_events").select(ce_fields).eq(
                "name", row["name"]
            ).eq("date", row["date"]).execute()

        if not match.data:
            not_found += 1
            not_found_events.append({
                "id": row["id"],
                "name": row["name"],
                "date": row["date"],
                "source": row.get("source"),
                "source_id": row.get("source_id"),
            })
            click.echo(f"  NOT FOUND: {row['name']} ({row['date']}) [{row.get('source')}:{row.get('source_id')}]")
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

        # Simple fields: only update if scraper_all has a value AND it differs
        for sa_field, ce_field in SYNC_FIELDS.items():
            if ce_field is None:
                continue  # is_kids handled above
            if sa_field in ("event_types", "distances"):
                continue  # handled above
            val = row.get(sa_field)
            if val is not None and val != ce.get(ce_field):
                updates[ce_field] = val

        # Mark enriched. Use whichever timestamp is set — search-only rows have
        # enriched_at=NULL but enriched_search_at populated.
        updates["enriched_at"] = row.get("enriched_at") or row.get("enriched_search_at")

        # Respect locked_fields — admin-corrected / audit-nulled fields must never be overwritten
        locked = ce.get("locked_fields") or []
        updates = filter_locked_fields(updates, locked)

        if locked:
            click.echo(f"    (respecting locked_fields={locked})")

        # Filter out enriched_at if it's the only change
        real_changes = {k: v for k, v in updates.items() if k != "enriched_at"}
        if not real_changes:
            skipped += 1
            continue

        prefix = "WOULD UPDATE" if dry_run else "✓ UPDATED"
        click.echo(f"\n  {prefix}: {row['name']}")
        for field, new_val in sorted(updates.items()):
            if field == "enriched_at":
                continue
            ce_field = field
            old_val = ce.get(ce_field)
            old_str = _fmt(old_val)
            new_str = _fmt(new_val)
            click.echo(f"    {field:25s} {old_str} → {new_str}")

        if not dry_run:
            try:
                sb.from_("calendar_events").update(updates).eq("id", ce["id"]).execute()
                updated += 1
                updated_events.append({
                    "id": row["id"],
                    "calendar_event_id": ce["id"],
                    "name": row["name"],
                    "fields": list(real_changes.keys()),
                })
            except Exception as e:
                errors.append({"id": row["id"], "name": row["name"], "message": str(e)})
        else:
            updated += 1

    click.echo(f"\n{'=== DRY RUN ===' if dry_run else '=== DONE ==='}")
    click.echo(f"  updated: {updated}")
    click.echo(f"  skipped (no changes): {skipped}")
    click.echo(f"  not in calendar_events: {not_found}")
    if errors:
        click.echo(f"  errors: {len(errors)}")
        for e in errors:
            click.echo(f"    {e['name']}: {e['message']}")

    if not dry_run:
        log_dir = "logs"
        os.makedirs(log_dir, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        log_path = os.path.join(log_dir, f"sync-{ts}.json")
        summary = {
            "script": "sync",
            "started_at": started_at,
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "since": since,
            "candidates": len(all_rows),
            "updated": updated,
            "skipped": skipped,
            "not_found": not_found,
            "errors_count": len(errors),
            "updated_events": updated_events,
            "not_found_events": not_found_events,
            "errors": errors,
        }
        with open(log_path, "w") as f:
            json.dump(summary, f, indent=2, ensure_ascii=False)
        click.echo(f"  Run log: {log_path}")
