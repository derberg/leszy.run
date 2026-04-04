import httpx
from urllib.parse import urlparse


def search_missing_urls(event: dict, missing_fields: list[str], config) -> dict:
    """Search SearXNG for missing URLs. Returns {field_name: url} for found candidates."""
    if not missing_fields:
        return {}

    name = event.get("name", "")
    date = event.get("date", "")
    year = date[:4] if date else ""
    location = event.get("location", "")

    queries = {}
    if "registration_url" in missing_fields:
        queries["registration_url"] = f"{name} {year} zapisy rejestracja {location}"
    if "regulamin_url" in missing_fields:
        queries["regulamin_url"] = f"{name} {year} regulamin"
    if "website" in missing_fields:
        queries["website"] = f"{name} {year} {location}"

    results = {}
    for field, query in queries.items():
        url = _searxng_search(query, config)
        if url:
            results[field] = url

    return results


def _searxng_search(query: str, config) -> str | None:
    """Call SearXNG and return the first non-aggregator URL."""
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{config.searxng_url}/search",
                params={"q": query, "format": "json", "language": "pl", "categories": "general"},
            )
            resp.raise_for_status()

        data = resp.json()
        for item in data.get("results", []):
            url = item.get("url", "")
            if url and not _is_aggregator(url, config.aggregator_domains):
                return url
    except (httpx.HTTPError, Exception):
        pass
    return None


def _is_aggregator(url: str, domains: list[str]) -> bool:
    try:
        hostname = urlparse(url).hostname or ""
        hostname = hostname.removeprefix("www.")
        return any(hostname == d or hostname.endswith(f".{d}") for d in domains)
    except Exception:
        return False
