import re as _re_module
from urllib.parse import urlparse

import httpx

from enricher.steps.validate_urls import UrlStatus

TERRAIN_TYPES = {"trail", "ocr", "uliczny"}
# Types that carry specific meaning from scraper keyword evidence.
# LLM should not drop these in favor of the generic "uliczny" default.
SPECIFIC_TYPES = {"trail", "ocr", "charytatywny", "nordic walking"}

NOT_OFFICIAL_DOMAINS = {
    # News / portals
    "wiaralecha.pl", "moje-gniezno.pl", "bieganie.pl", "sport.pl",
    "onet.pl", "wp.pl", "gazeta.pl", "naszemiasto.pl", "dziennik.pl",
    # Aggregators / registration platforms (not event's own site)
    "maratonypolskie.pl", "datasport.pl", "liveds.datasport.pl",
    "elektronicznezapisy.pl", "biegiwpolsce.pl", "dostartu.pl",
    "domtel-sport.pl",
}

# Social platforms that many small event organizers use as their primary online
# presence. Acceptable as website when no dedicated domain exists, but a real
# domain should be preferred if one is found.
SOCIAL_FALLBACK_DOMAINS = {
    "facebook.com", "www.facebook.com", "m.facebook.com",
    "instagram.com", "www.instagram.com",
}


def _is_official_domain(url: str) -> bool:
    """Check if URL looks like an official event site (not news/aggregator)."""
    try:
        host = urlparse(url).hostname or ""
        return not any(host == d or host.endswith("." + d) for d in NOT_OFFICIAL_DOMAINS)
    except Exception:
        return True


def _is_social_fallback(url: str) -> bool:
    """True if URL is a social-platform page (Facebook, Instagram, etc.).

    These are acceptable as a fallback website but should be replaced when a
    real event domain is available.
    """
    try:
        host = urlparse(url).hostname or ""
        return any(host == d or host.endswith("." + d) for d in SOCIAL_FALLBACK_DOMAINS)
    except Exception:
        return False


_POLISH_MAP = str.maketrans(
    "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ",
    "acelnoszZACELNOSZZ",
)

_URL_VERIFY_STOPWORDS = {
    "bieg", "biegu", "biegi", "maraton", "polmaraton", "run", "running",
    "edycja", "im", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii",
    "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii",
    "xix", "xx", "o", "w", "na", "do", "po", "z", "ze", "we", "ku",
    "dla", "od", "przy", "nad", "pod", "przez",
}


def _tokenize_name(name: str) -> list[str]:
    """Extract meaningful tokens (4+ chars, no stopwords) from event name."""
    normalized = name.lower().translate(_POLISH_MAP)
    tokens = _re_module.findall(r"[a-z0-9]+", normalized)
    return [t for t in tokens if len(t) >= 4 and t not in _URL_VERIFY_STOPWORDS]


def verify_url_relevance(url: str, event_name: str) -> bool:
    """Fetch a URL and check that the page content mentions the event.

    Returns True if at least half of the meaningful name tokens appear on the
    page, or if the page couldn't be fetched (benefit of the doubt on timeouts).
    Social media URLs are trusted without checking (hard to scrape).
    """
    if not url or not event_name:
        return True

    # Social media pages are hard to scrape — trust the LLM's judgment
    try:
        host = (urlparse(url).hostname or "").lower()
        if any(host == d or host.endswith("." + d) for d in SOCIAL_FALLBACK_DOMAINS):
            return True
    except Exception:
        pass

    tokens = _tokenize_name(event_name)
    if not tokens:
        return True  # no meaningful tokens to check

    try:
        with httpx.Client(
            follow_redirects=True, timeout=10,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept-Language": "pl,en-US;q=0.9",
            },
        ) as client:
            resp = client.get(url)
            if resp.status_code >= 400:
                return True  # can't verify, allow it
            text = resp.text.lower().translate(_POLISH_MAP)
    except (httpx.HTTPError, Exception):
        return True  # network error, benefit of the doubt

    hits = sum(1 for t in tokens if t in text)
    return hits >= max(1, len(tokens) // 2)


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
    _merge_urls(event, llm, url_statuses, search_candidates, updates, event.get("name", ""))

    # --- is_kids ---
    llm_kids = llm.get("is_kids")
    if llm_kids is not None:
        if had_content:
            # LLM read actual pages — authoritative, can correct false↔true
            if event.get("is_kids") != llm_kids:
                updates["is_kids"] = llm_kids
        elif event.get("is_kids") is None:
            updates["is_kids"] = llm_kids

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
        # drop specific types (trail/ocr/charytatywny) that the scraper found
        # via keyword evidence. The LLM defaults to "uliczny" when unsure.
        existing_specific = set(current) & SPECIFIC_TYPES
        llm_has_those = set(valid) & existing_specific
        lost = existing_specific - llm_has_those
        if lost:
            # LLM dropped specific types → preserve them, merge in LLM's additions
            merged = set(current) | set(valid)
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

    for field in ["price_from", "price_to", "registration_deadline", "voivodeship", "location"]:
        value = llm.get(field)
        if value is None:
            continue

        # Voivodeship: only fill empty, never overwrite (scraper has geocoding evidence)
        if field == "voivodeship":
            if value not in config.voivodeships:
                continue
            if event.get("voivodeship"):
                continue

        # Location: only fill empty, never overwrite (scraper city is usually authoritative)
        if field == "location":
            if not isinstance(value, str) or not value.strip():
                continue
            if event.get("location"):
                continue
            value = value.strip()

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

        # Validate price is a positive number, cast to int (DB column is integer)
        if field in ("price_from", "price_to"):
            if not isinstance(value, (int, float)) or value < 0:
                continue
            value = int(round(value))
            # Only fill empty — scraper-extracted prices are more reliable than LLM
            if event.get(field) is not None:
                continue

        # registration_deadline: only fill empty — scraper-stated deadline is authoritative
        if field == "registration_deadline":
            if event.get(field):
                continue

        # Rule 5: overwrite if LLM has a value
        if event.get(field) != value:
            updates[field] = value

    # Sanity: price_from must be <= price_to
    pf = updates.get("price_from", llm.get("price_from"))
    pt = updates.get("price_to", llm.get("price_to"))
    if pf is not None and pt is not None and pf > pt:
        updates.pop("price_from", None)
        updates.pop("price_to", None)


def _merge_urls(event, llm, url_statuses, search_candidates, updates, event_name=""):
    """Handle URL replacement based on validation + LLM confirmation.

    NEVER null a working URL — only replace when there's an actual candidate.

    Search candidates are ONLY written when the LLM (after reading the crawled
    page) confirms they match the expected type. Previously, a raw SearXNG
    result could be written directly to the DB — which led to Chinese Q&A
    sites and German Wikipedia pages overwriting valid Polish event URLs.
    The LLM's confirm flag is now required on every write path.

    Every candidate URL is verified by fetching it and checking that the page
    content mentions the event name — prevents unrelated URLs (e.g. trail
    mapping sites) from being stored.
    """
    for field, llm_field, llm_flag in [
        ("registration_url", "registration_url", "url_is_registration"),
        ("regulamin_url", "regulamin_url", "url_is_regulamin"),
    ]:
        status = url_statuses.get(field)
        search_candidate = search_candidates.get(field)
        llm_url = llm.get(llm_field)
        llm_confirms = llm.get(llm_flag) is True

        def _pick_candidate():
            """Return the confirmed + verified candidate URL, or None."""
            if llm_url and llm_confirms:
                if verify_url_relevance(llm_url, event_name):
                    return llm_url
            if search_candidate and llm_confirms:
                if verify_url_relevance(search_candidate, event_name):
                    return search_candidate
            return None

        # Fill empty field
        if not event.get(field):
            picked = _pick_candidate()
            if picked:
                updates[field] = picked
            continue

        # Dead URL → replace only with confirmed candidate
        if status and status.status == "dead":
            picked = _pick_candidate()
            if picked:
                updates[field] = picked
            continue

        # LLM says existing URL is wrong type → replace with search candidate
        # (LLM explicitly rejected the existing URL, so the search candidate
        # found specifically for this field type is acceptable without a
        # separate LLM confirmation — but still must pass relevance check)
        if llm.get(llm_flag) is False and event.get(field):
            picked = _pick_candidate()
            if not picked and search_candidate and verify_url_relevance(search_candidate, event_name):
                picked = search_candidate
            if picked:
                updates[field] = picked
            continue

    # Website: three valid write paths
    #   1. LLM-confirmed official URL → always acceptable
    #   2. LLM-unconfirmed but social-platform URL (FB/Instagram) → acceptable
    #      as a fallback when the field is empty (small events often have only
    #      a Facebook page)
    #   3. LLM-confirmed official URL → also replaces a current social-only
    #      website, because a real domain is better than a FB page
    # What is NOT acceptable: any other LLM suggestion without the official
    # flag — that's how Google search / translate pages ended up stored.
    #
    # All candidates are verified by fetching the page and checking the event
    # name appears in the content.
    llm_website = llm.get("website")
    llm_is_official = llm.get("website_is_official", False)
    if llm_website and verify_url_relevance(llm_website, event_name):
        current = event.get("website", "")
        if llm_is_official:
            # Real domain — fill empty OR upgrade from news/aggregator/social fallback
            if not current:
                updates["website"] = llm_website
            elif not _is_official_domain(current) or _is_social_fallback(current):
                updates["website"] = llm_website
        elif _is_social_fallback(llm_website) and not current:
            # Social-only page is better than nothing for small events
            updates["website"] = llm_website
