import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from enricher.steps.crawl import crawl_pages, CrawlResult


@pytest.mark.asyncio
async def test_crawl_deduplicates_urls():
    """If website and registration_url are the same, only crawl once."""
    with patch("enricher.steps.crawl._crawl_url", new_callable=AsyncMock) as mock_crawl:
        mock_crawl.return_value = CrawlResult(url="https://example.pl", content="# Event Page\nRegistration open", chars=30)
        result = await crawl_pages(
            urls={"registration_url": "https://example.pl", "website": "https://example.pl"},
            max_chars=10_000,
        )
    # Should only crawl once despite two fields pointing to same URL
    assert mock_crawl.call_count == 1
    assert "registration_url" in result
    assert "website" in result
    assert result["registration_url"].content == result["website"].content


@pytest.mark.asyncio
async def test_crawl_truncates_long_content():
    with patch("enricher.steps.crawl._crawl_url", new_callable=AsyncMock) as mock_crawl:
        mock_crawl.return_value = CrawlResult(url="https://example.pl", content="x" * 5000, chars=5000)
        result = await crawl_pages(
            urls={"website": "https://example.pl"},
            max_chars=5000,
        )
    assert len(result["website"].content) <= 5000


@pytest.mark.asyncio
async def test_crawl_skips_none_urls():
    result = await crawl_pages(urls={"website": None}, max_chars=10_000)
    assert len(result) == 0


@pytest.mark.asyncio
async def test_crawl_handles_failure():
    with patch("enricher.steps.crawl._crawl_url", new_callable=AsyncMock) as mock_crawl:
        mock_crawl.return_value = None
        result = await crawl_pages(
            urls={"website": "https://broken.pl"},
            max_chars=10_000,
        )
    assert result.get("website") is None
