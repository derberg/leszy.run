import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult
from enricher.steps.verify import VerifyResult

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
            "regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive", is_pdf=True, kind="pdf"),
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
async def test_process_event_searched_regulamin_docx(sample_event):
    """A regulamin found by SEARCH (not on the event) must be classified by kind and
    extracted via extract_regulamin_doc — not HTML-crawled, not download_pdf'd.

    This is the 'search for regulamin, then enrich from its content' path for a
    non-HTML regulamin (here a .docx)."""
    sample_event["regulamin_url"] = None  # force the search path

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_regulamin_doc", new_callable=AsyncMock) as mock_doc,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.build_updates") as mock_merge,
        patch("enricher.pipeline.verify_search_candidate") as mock_verify,
    ):
        mock_verify.return_value = VerifyResult(ok=True, verdict="match", confidence=0.9, reasoning="pinned")
        # validate_urls is called twice: Step 1 (existing URLs — regulamin missing),
        # then again on the searched regulamin candidate to classify its kind.
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url="https://example.pl/zapisy", status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url="https://x.pl/reg.docx", status="alive", kind="docx")},
        ]
        mock_search.return_value = {"regulamin_url": "https://x.pl/reg.docx"}
        mock_crawl.return_value = {
            "registration_url": CrawlResult(url="https://example.pl/zapisy", content="# Zapisy", chars=7),
        }
        mock_doc.return_value = "Regulamin: dystans 21 km, opłata 50 zł"
        mock_prompt.return_value = "p"
        mock_llm.return_value = {"distances": ["21 km"]}
        mock_merge.return_value = {"distances": "21 km"}

        result = await process_event(sample_event, config)

    mock_doc.assert_called_once()
    called_url, called_kind = mock_doc.call_args[0][:2]
    assert called_url == "https://x.pl/reg.docx"
    assert called_kind == "docx"
    mock_download.assert_not_called()  # docx is not a PDF
    assert result["steps"]["search"]["regulamin_kind"] == "docx"
    assert result["updates"] == {"distances": "21 km"}


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
        patch("enricher.pipeline.verify_search_candidate") as mock_verify,
    ):
        mock_verify.return_value = VerifyResult(ok=True, verdict="match", confidence=0.9, reasoning="pinned")
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


@pytest.mark.asyncio
async def test_rejected_searched_regulamin_pdf_is_not_adopted(sample_event):
    """A search-found regulamin PDF that fails the gate reaches neither the
    field nor extraction.

    Before the gate existed, a discovered PDF was pushed into search_candidates
    without ever entering crawled_content, so the token check could not see it
    and merge received it unchecked."""
    sample_event["regulamin_url"] = None

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.verify_search_candidate") as mock_verify,
    ):
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url="https://example.pl/zapisy", status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url="https://wrong.pl/reg.pdf", status="alive", is_pdf=True, kind="pdf")},
        ]
        mock_search.return_value = {"regulamin_url": "https://wrong.pl/reg.pdf"}
        mock_crawl.return_value = {
            "registration_url": CrawlResult(url="https://example.pl/zapisy", content="# Zapisy", chars=7),
        }
        mock_download.return_value = "/tmp/wrong.pdf"
        # A different race's rules: 100 km and 300 zl must not reach this event.
        mock_pdf.return_value = "Regulamin Biegu Rzeznika: dystans 100 km, oplata 300 zl"
        mock_verify.return_value = VerifyResult(
            ok=False, verdict="mismatch", confidence=0.95,
            reasoning="Rules document describes a different race.", llm_called=True,
        )
        mock_prompt.return_value = "p"
        mock_llm.return_value = {}

        result = await process_event(sample_event, config)

    assert mock_verify.called, "the searched PDF must be put through the gate"
    assert "regulamin_url" not in result["updates"]
    assert result["steps"]["verify"]["dropped"] == 1
    assert result["steps"]["verify"]["kept"] == 0
    # The rejected document is kept out of extraction too: build_prompt takes
    # pdf_text as its third positional argument, and it must arrive empty.
    pdf_text_arg = mock_prompt.call_args[0][2]
    assert not pdf_text_arg, f"rejected regulamin text reached the prompt: {pdf_text_arg!r}"
    assert result["updates"].get("price_from") is None
    assert result["updates"].get("distances") is None


@pytest.mark.asyncio
async def test_scraper_declared_urls_skip_the_gate(sample_event):
    """An organizer-declared URL is never verified."""
    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text") as mock_pdf,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.build_updates") as mock_merge,
        patch("enricher.pipeline.verify_search_candidate") as mock_verify,
    ):
        mock_validate.return_value = {
            "registration_url": UrlStatus(url="https://example.pl/zapisy", status="alive", kind="html"),
            "regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive", is_pdf=True, kind="pdf"),
        }
        mock_search.return_value = {}   # nothing missing, so no search runs
        mock_crawl.return_value = {
            "registration_url": CrawlResult(url="https://example.pl/zapisy", content="# Zapisy", chars=7),
        }
        mock_download.return_value = "/tmp/fake.pdf"
        mock_pdf.return_value = "Regulamin: dystans 5 km"
        mock_prompt.return_value = "p"
        mock_llm.return_value = {}
        mock_merge.return_value = {"distances": "5 km"}

        result = await process_event(sample_event, config)

    mock_verify.assert_not_called()
    assert result["steps"]["verify"]["checked"] == 0
    assert result["updates"] == {"distances": "5 km"}
