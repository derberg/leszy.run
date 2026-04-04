import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult

config = Config()


@pytest.mark.asyncio
async def test_process_event_full_flow(sample_event, sample_llm_response):
    """Full pipeline for one event: validate → search → crawl → llm → merge."""
    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.build_updates") as mock_merge,
    ):
        mock_validate.return_value = {
            "registration_url": UrlStatus(url="https://example.pl/zapisy", status="alive"),
            "regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive", is_pdf=True),
        }
        mock_search.return_value = {}
        mock_crawl.return_value = {
            "registration_url": CrawlResult(url="https://example.pl/zapisy", content="# Zapisy", chars=7),
        }
        mock_download.return_value = "/tmp/fake.pdf"
        mock_pdf.return_value = "Regulamin: dystans 5 km"
        mock_prompt.return_value = "test prompt"
        mock_llm.return_value = sample_llm_response
        mock_merge.return_value = {"distances": "5 km, 10 km", "price_from": 40}

        result = await process_event(sample_event, config)

    assert result["updates"] == {"distances": "5 km, 10 km", "price_from": 40}
    mock_validate.assert_called_once()
    mock_crawl.assert_called_once()
    mock_download.assert_called_once()
    mock_pdf.assert_called_once()
    mock_llm.assert_called_once()


@pytest.mark.asyncio
async def test_process_event_no_urls(sample_event):
    """Event with no URLs at all — should skip crawl/pdf, still call LLM."""
    sample_event["registration_url"] = None
    sample_event["regulamin_url"] = None
    sample_event["website"] = None

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.build_updates") as mock_merge,
    ):
        mock_validate.return_value = {}
        mock_search.return_value = {"registration_url": "https://found.pl/zapisy"}
        mock_crawl.return_value = {}
        mock_prompt.return_value = "test prompt"
        mock_llm.return_value = {"distances": ["5 km"], "event_types": None}
        mock_merge.return_value = {"distances": "5 km"}

        result = await process_event(sample_event, config)

    mock_search.assert_called_once()
    mock_download.assert_not_called()  # No PDF URL
    assert result["updates"] == {"distances": "5 km"}
