from dataclasses import dataclass
from typing import Optional
import httpx

from enricher.steps.docs import classify_doc_url


@dataclass
class UrlStatus:
    url: str
    status: str  # "alive", "dead"
    final_url: Optional[str] = None  # set if redirected
    is_pdf: bool = False
    kind: str = "html"  # 'pdf' | 'docx' | 'drive_folder' | 'drive_file' | 'html'
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


# Fewer bytes than this is not a page. A 200 with an empty body is what a
# throttling or half-broken CMS returns, and the crawler reads nothing from it.
_MIN_BODY_BYTES = 32


def _has_body(resp) -> bool:
    """True when the response headers already prove the page has content."""
    length = resp.headers.get("content-length")
    return length is not None and length.isdigit() and int(length) >= _MIN_BODY_BYTES


def _check_url(url: str, field_name: str, timeout: int) -> UrlStatus:
    """Validate a URL. HEAD first (cheap); on HEAD failure / 4xx / 5xx, retry with GET.

    Many Polish event CMSes (Joomla, old PHP stacks) return 403/405 to HEAD but
    200 to GET. Relying on HEAD alone falsely marks working sites as dead and
    causes the pipeline to overwrite them with search candidates.

    A 200 is not enough either. kaszubybiegaja.pl answers HEAD 200 with no
    content-length and GET 200 with content-length 0 for its regulamin page.
    Called alive, that page is never re-searched and the crawler extracts
    nothing from it. So for HTML pages, when HEAD does not prove a body, we
    confirm with GET and call an empty body dead. Binary regulamins (pdf, docx,
    drive) stay on the HEAD path so validation never downloads the file.
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

            body_checked = resp.request.method == "GET"
            head_kind = classify_doc_url(url, resp.headers.get("content-type", ""))

            # HEAD said 200 but proved nothing about the body, so read the page.
            if not body_checked and head_kind == "html" and not _has_body(resp):
                resp = client.get(resp.url)
                body_checked = True

        final_url = str(resp.url) if str(resp.url) != url else None
        content_type = resp.headers.get("content-type", "")
        kind = classify_doc_url(url, content_type)
        is_pdf = kind == "pdf"
        is_empty = body_checked and len(resp.content.strip()) < _MIN_BODY_BYTES

        if resp.status_code < 400 and is_empty:
            return UrlStatus(url=url, status="dead", error="empty body")

        if resp.status_code < 400:
            return UrlStatus(
                url=url,
                status="alive",
                final_url=final_url,
                is_pdf=is_pdf,
                kind=kind,
            )
        else:
            return UrlStatus(url=url, status="dead", error=f"HTTP {resp.status_code}")

    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        return UrlStatus(url=url, status="dead", error=str(e)[:100])
