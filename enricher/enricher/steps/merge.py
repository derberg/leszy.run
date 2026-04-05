from urllib.parse import urlparse
from enricher.steps.validate_urls import UrlStatus

TERRAIN_TYPES = {"trail", "ocr", "uliczny"}

NOT_OFFICIAL_DOMAINS = {
    # News / portals
    "wiaralecha.pl", "moje-gniezno.pl", "bieganie.pl", "sport.pl",
    "onet.pl", "wp.pl", "gazeta.pl", "naszemiasto.pl", "dziennik.pl",
    # Social
    "facebook.com", "www.facebook.com",
    # Aggregators / registration platforms (not event's own site)
    "maratonypolskie.pl", "datasport.pl", "liveds.datasport.pl",
    "elektronicznezapisy.pl", "biegiwpolsce.pl", "dostartu.pl",
    "domtel-sport.pl",
}


def _is_official_domain(url: str) -> bool:
    """Check if URL looks like an official event site (not news/social)."""
    try:
        host = urlparse(url).hostname or ""
        return not any(host == d or host.endswith("." + d) for d in NOT_OFFICIAL_DOMAINS)
    except Exception:
        return True


def build_updates(event: dict, llm: dict, url_statuses: dict, search_candidates: dict, config, had_content: bool = False) -> dict:
    """Compare LLM output with current event data and build update dict.

    Returns only fields that should be changed. Empty dict = no changes.
    had_content: True when LLM had crawled pages or PDF to analyze — makes it
    authoritative on event_types (overwrite instead of additive merge).
    """
    if not llm:
        return {}

    updates = {}

    # --- Distances (Rule 3) ---
    _merge_distances(event, llm, updates)

    # --- Event types (Rule 4) ---
    _merge_event_types(event, llm, updates, config, had_content)

    # --- Scalar fields (Rule 5: always overwrite from LLM) ---
    _merge_scalars(event, llm, updates, config)

    # --- URLs (Rule 2) ---
    _merge_urls(event, llm, url_statuses, search_candidates, updates)

    # --- is_kids ---
    if llm.get("is_kids") is not None and event.get("is_kids") is None:
        updates["is_kids"] = llm["is_kids"]

    return updates


def _parse_distances(dist_str: str) -> list:
    """Parse a distances string like '5 km, 10 km, 6h' into a list."""
    if not dist_str or not dist_str.strip():
        return []
    return [d.strip() for d in dist_str.split(",") if d.strip()]


def _merge_distances(event, llm, updates):
    llm_distances = llm.get("distances")
    if not llm_distances or not isinstance(llm_distances, list) or len(llm_distances) == 0:
        return

    current = _parse_distances(event.get("distances", ""))
    new_count = len(llm_distances)
    current_count = len(current)

    if current_count == 0:
        # Rule 1: empty → fill
        updates["distances"] = ", ".join(llm_distances)
    elif new_count > current_count:
        # Rule 3: more complete → overwrite
        updates["distances"] = ", ".join(llm_distances)
    # else: keep current (same count or fewer)


def _merge_event_types(event, llm, updates, config, had_content: bool = False):
    llm_types = llm.get("event_types")
    if not llm_types or not isinstance(llm_types, list) or len(llm_types) == 0:
        return

    valid = [t for t in llm_types if t in config.valid_event_types]
    if not valid:
        return

    current = event.get("event_types") or []
    if not current:
        updates["event_types"] = valid
        return

    if had_content:
        # LLM read the actual pages — trust its classification, but never
        # downgrade a specific terrain type (trail/ocr) to the default (uliczny).
        # "uliczny" is what the LLM picks when unsure. If the scraper had
        # keyword evidence for trail/ocr, preserve it.
        existing_specific = set(current) & TERRAIN_TYPES - {"uliczny"}
        llm_specific = set(valid) & TERRAIN_TYPES - {"uliczny"}
        if existing_specific and not llm_specific:
            # LLM only has uliczny but scraper had trail/ocr → keep existing terrain,
            # merge in any non-terrain types the LLM found (nocny, charytatywny, etc.)
            merged = set(current) | {t for t in valid if t not in TERRAIN_TYPES}
            new_set = sorted(merged)
        else:
            new_set = sorted(set(valid))
        if set(new_set) != set(current):
            updates["event_types"] = new_set
        return

    # No content — additive merge with terrain conflict resolution
    merged = set(current)
    existing_terrain = [t for t in current if t in TERRAIN_TYPES]

    for t in valid:
        if t in TERRAIN_TYPES and existing_terrain and t not in existing_terrain:
            continue  # Skip conflicting terrain
        merged.add(t)

    merged_list = sorted(merged)
    if set(merged_list) != set(current):
        updates["event_types"] = merged_list


def _merge_scalars(event, llm, updates, config):
    """Scalar fields: always overwrite from LLM (it reads the actual source)."""
    import re as _re

    for field in ["price_from", "price_to", "registration_deadline", "voivodeship"]:
        value = llm.get(field)
        if value is None:
            continue

        # Validate voivodeship
        if field == "voivodeship" and value not in config.voivodeships:
            continue

        # Validate deadline format and year (must be within 1 year of event date)
        if field == "registration_deadline":
            if not _re.match(r"^\d{4}-\d{2}-\d{2}$", str(value)):
                continue
            event_date = event.get("date", "")
            if event_date:
                try:
                    from datetime import date as _date
                    ev = _date.fromisoformat(event_date)
                    dl = _date.fromisoformat(str(value))
                    if abs((ev - dl).days) > 365:
                        continue
                except (ValueError, TypeError):
                    pass

        # Validate price is a positive number
        if field in ("price_from", "price_to"):
            if not isinstance(value, (int, float)) or value <= 0:
                continue

        # Rule 5: overwrite if LLM has a value
        if event.get(field) != value:
            updates[field] = value


def _merge_urls(event, llm, url_statuses, search_candidates, updates):
    """Handle URL replacement based on validation + LLM confirmation.

    NEVER null a working URL — only replace when there's an actual candidate.
    """
    for field, llm_flag in [
        ("registration_url", "url_is_registration"),
        ("regulamin_url", "url_is_regulamin"),
    ]:
        status = url_statuses.get(field)
        candidate = search_candidates.get(field)

        # Dead URL → replace only if we have a candidate
        if status and status.status == "dead" and candidate:
            updates[field] = candidate
            continue

        # LLM says URL is wrong type → replace only if we have a candidate
        if llm.get(llm_flag) is False and event.get(field) and candidate:
            updates[field] = candidate
            continue

    # Website: fill if empty, or replace with LLM's suggestion if it's an official site
    llm_website = llm.get("website")
    if llm_website:
        llm_is_official = llm.get("website_is_official", False)
        if not event.get("website"):
            updates["website"] = llm_website
        elif llm_is_official and not _is_official_domain(event.get("website", "")):
            updates["website"] = llm_website
