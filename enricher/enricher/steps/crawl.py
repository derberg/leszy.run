from dataclasses import dataclass
from typing import Optional


@dataclass
class CrawlResult:
    url: str
    content: str
    chars: int


async def crawl_pages(urls: dict, max_chars: int = 10_000) -> dict[str, Optional[CrawlResult]]:
    """Crawl all valid URLs. Returns {field_name: CrawlResult or None}.

    Deduplicates: if multiple fields point to the same URL, crawl once and reuse.
    """
    # Build url → [field_names] mapping to deduplicate
    url_to_fields = {}
    for field, url in urls.items():
        if url and isinstance(url, str):
            url_to_fields.setdefault(url, []).append(field)

    # Crawl each unique URL
    url_results = {}
    for url in url_to_fields:
        result = await _crawl_url(url, max_chars)
        url_results[url] = result

    # Map back to field names
    results = {}
    for url, fields in url_to_fields.items():
        for field in fields:
            results[field] = url_results.get(url)

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

        return CrawlResult(url=url, content=content, chars=len(content))

    except Exception:
        return None
