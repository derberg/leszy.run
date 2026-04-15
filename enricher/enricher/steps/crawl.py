from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CrawlResult:
    url: str
    content: str
    chars: int
    internal_links: list = field(default_factory=list)  # [{href, text}]
    external_links: list = field(default_factory=list)  # [{href, text}]


async def crawl_pages(urls: dict, max_chars: int = 10_000) -> dict[str, Optional[CrawlResult]]:
    """Crawl all valid URLs. Returns {field_name: CrawlResult or None}.

    Deduplicates: if multiple fields point to the same URL, crawl once and reuse.
    """
    # Build url → [field_names] mapping to deduplicate
    url_to_fields = {}
    for field_name, url in urls.items():
        if url and isinstance(url, str):
            url_to_fields.setdefault(url, []).append(field_name)

    # Crawl each unique URL
    url_results = {}
    for url in url_to_fields:
        result = await _crawl_url(url, max_chars)
        url_results[url] = result

    # Map back to field names
    results = {}
    for url, fields in url_to_fields.items():
        for field_name in fields:
            results[field_name] = url_results.get(url)

    return results


async def crawl_url_list(urls: list, max_chars: int = 10_000) -> dict:
    """Crawl a plain list of URLs. Returns {url: CrawlResult or None}. Deduplicates."""
    seen = set()
    results = {}
    for url in urls:
        if not url or url in seen:
            continue
        seen.add(url)
        results[url] = await _crawl_url(url, max_chars)
    return results


async def _crawl_url(url: str, max_chars: int) -> Optional[CrawlResult]:
    """Crawl a single URL using Crawl4AI. Returns None on failure."""
    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig

        config = CrawlerRunConfig(wait_until="networkidle")
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url, config=config)

        if not result.success:
            return None

        # Prefer markdown_v2 if available, fall back to markdown
        content = ""
        if hasattr(result, "markdown_v2") and result.markdown_v2:
            content = result.markdown_v2.raw_markdown or ""
        elif hasattr(result, "markdown"):
            content = result.markdown or ""

        content = content[:max_chars]
        if not content.strip():
            return None

        internal = _normalize_links(getattr(result, "links", {}).get("internal", []))
        external = _normalize_links(getattr(result, "links", {}).get("external", []))

        return CrawlResult(
            url=url,
            content=content,
            chars=len(content),
            internal_links=internal,
            external_links=external,
        )

    except Exception:
        return None


def _normalize_links(raw: list) -> list:
    """Normalize Crawl4AI link dicts to {href, text}."""
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        href = (item.get("href") or "").strip()
        text = (item.get("text") or "").strip()
        if href:
            out.append({"href": href, "text": text})
    return out
