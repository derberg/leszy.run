"""Fast-path HTTP fetch and lightweight HTML parsing for the audit command.

Extracts just enough of a page (title, meta description, h1 texts, body sample)
to feed a short LLM prompt. No JS rendering — that is the full-path fallback's
job (Crawl4AI).
"""
from dataclasses import dataclass, field
from typing import Optional

import httpx
from bs4 import BeautifulSoup


# Same headers as validate_urls.py — many Polish CMSes gatekeep on UA.
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pl,en-US;q=0.9,en;q=0.8",
}


@dataclass
class FastPage:
    url: str
    final_url: str = ""
    status: str = "ok"          # "ok" | "dead"
    http_status: int = 0
    title: str = ""
    meta_description: str = ""
    h1: list = field(default_factory=list)
    body_sample: str = ""
    error: Optional[str] = None


def fetch_fast(url: str, timeout: int = 10, body_chars: int = 2000) -> Optional[FastPage]:
    """Fetch a URL via plain HTTP GET and extract a FastPage.

    Returns None only on catastrophic failures that we want to swallow in the
    caller (we don't currently have any — this is future-proofing).
    """
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers=_BROWSER_HEADERS,
        ) as client:
            resp = client.get(url)
    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        return FastPage(url=url, status="dead", error=str(e)[:200])

    if resp.status_code >= 400:
        return FastPage(
            url=url,
            final_url=str(resp.url),
            status="dead",
            http_status=resp.status_code,
            error=f"HTTP {resp.status_code}",
        )

    content_type = resp.headers.get("content-type", "").lower()
    if "html" not in content_type and "xml" not in content_type:
        return FastPage(
            url=url,
            final_url=str(resp.url),
            status="dead",
            http_status=resp.status_code,
            error="non-html content",
        )

    page = parse_html(resp.text, body_chars=body_chars)
    page.url = url
    page.final_url = str(resp.url)
    page.http_status = resp.status_code
    page.status = "ok"
    return page


def parse_html(html: str, body_chars: int = 2000) -> FastPage:
    """Parse HTML into a FastPage (no network I/O)."""
    soup = BeautifulSoup(html or "", "html.parser")

    # Strip noise
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()

    h1_tags = soup.find_all("h1", limit=5)
    h1_texts = [t.get_text(" ", strip=True) for t in h1_tags if t.get_text(strip=True)]

    # Body sample: visible text of body, whitespace-collapsed, truncated
    body_root = soup.body or soup
    body_text = body_root.get_text(" ", strip=True)
    # Collapse runs of whitespace
    body_text = " ".join(body_text.split())
    body_sample = body_text[:body_chars]

    return FastPage(
        url="",
        title=title,
        meta_description=meta_desc,
        h1=h1_texts,
        body_sample=body_sample,
    )
