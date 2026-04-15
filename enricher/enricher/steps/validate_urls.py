from dataclasses import dataclass
from typing import Optional
import httpx


@dataclass
class UrlStatus:
    url: str
    status: str  # "alive", "dead"
    final_url: Optional[str] = None  # set if redirected
    is_pdf: bool = False
    error: Optional[str] = None


def validate_urls(urls_dict: dict, timeout: int = 10) -> dict[str, UrlStatus]:
    """Validate all URLs on an event. Returns {field_name: UrlStatus}.

    urls_dict keys: registration_url, regulamin_url, regulamin_urls, website
    regulamin_urls is a list — each entry gets its own result keyed as regulamin_urls[i].
    None values are skipped.
    """
    results = {}

    flat = {}
    for key, value in urls_dict.items():
        if value is None:
            continue
        if key == "regulamin_urls" and isinstance(value, list):
            for i, url in enumerate(value):
                if url:
                    flat[f"regulamin_urls[{i}]"] = url
        elif isinstance(value, str) and value.strip():
            flat[key] = value

    for field_name, url in flat.items():
        results[field_name] = _check_url(url, field_name, timeout)

    return results


_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pl,en-US;q=0.9,en;q=0.8",
}


def _check_url(url: str, field_name: str, timeout: int) -> UrlStatus:
    """Validate a URL. HEAD first (cheap); on HEAD failure / 4xx / 5xx, retry with GET.

    Many Polish event CMSes (Joomla, old PHP stacks) return 403/405 to HEAD but
    200 to GET. Relying on HEAD alone falsely marks working sites as dead and
    causes the pipeline to overwrite them with search candidates.
    """
    try:
        with httpx.Client(
            follow_redirects=True, timeout=timeout, headers=_BROWSER_HEADERS
        ) as client:
            # Try HEAD first
            try:
                resp = client.head(url)
            except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError):
                resp = None

            # Fall back to GET when HEAD failed or returned error status
            if resp is None or resp.status_code >= 400:
                resp = client.get(url)

        final_url = str(resp.url) if str(resp.url) != url else None
        content_type = resp.headers.get("content-type", "")
        is_pdf = "pdf" in content_type.lower()

        if resp.status_code < 400:
            return UrlStatus(
                url=url,
                status="alive",
                final_url=final_url,
                is_pdf=is_pdf,
            )
        else:
            return UrlStatus(url=url, status="dead", error=f"HTTP {resp.status_code}")

    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        return UrlStatus(url=url, status="dead", error=str(e)[:100])
