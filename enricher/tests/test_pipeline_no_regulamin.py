"""What extraction reads when the event has no regulamin at all.

X-RUN Wielki Finał (2026-10-04, biegigorskie:x-run-wielki-final-2026-10-04)
published with price_from, price_to and registration_deadline null after two
enrichment passes. biegigorskie.pl links no rules document, search found none,
so regulamin_content stayed empty and build_prompt got "(No regulamin content
available)". The registration page https://xrun.pl/produkt/wielki-final-2026/
had been crawled in Step 3 and states 60.00-260.00 PLN, and the pipeline threw
that text away before the LLM saw it.
"""

import pytest
from unittest.mock import patch, AsyncMock

from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult

config = Config()

XRUN_PAGE = (
    "# Wielki Finał (2026)\n"
    "Żegiestów-Zdrój, 4 października 2026\n"
    "Opłata startowa: Kids 60,00 zł, Intro 90,00 zł, Classic 170,00 zł, "
    "Long 260,00 zł\n"
)


def _no_regulamin_event(sample_event):
    """A biegigorskie row: registration page only, no rules document anywhere."""
    sample_event["name"] = "X-RUN Wielki Finał"
    sample_event["date"] = "2026-10-04"
    sample_event["location"] = "Żegiestó Zdrój"
    sample_event["registration_url"] = "https://xrun.pl/produkt/wielki-final-2026/"
    sample_event["regulamin_url"] = None
    return sample_event


@pytest.mark.asyncio
async def test_registration_page_feeds_extraction_when_no_regulamin_exists(sample_event):
    """No regulamin found → the crawled registration page still reaches the prompt."""
    event = _no_regulamin_event(sample_event)

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
    ):
        mock_validate.return_value = {
            "registration_url": UrlStatus(
                url="https://xrun.pl/produkt/wielki-final-2026/", status="alive", kind="html",
            ),
        }
        mock_search.return_value = {}  # the portal links none and search finds none
        mock_crawl.return_value = {
            "registration_url": CrawlResult(
                url="https://xrun.pl/produkt/wielki-final-2026/",
                content=XRUN_PAGE,
                chars=len(XRUN_PAGE),
            ),
        }
        mock_prompt.return_value = "p"
        mock_llm.return_value = {}

        result = await process_event(event, config)

    mock_download.assert_not_called()
    # build_prompt(event, crawled, pdf_text, ...) — the second positional argument
    # is the content extraction reads.
    extraction_content = mock_prompt.call_args[0][1]
    assert extraction_content, "the crawled registration page was thrown away"
    assert any(
        "260,00 zł" in v for v in extraction_content.values()
    ), f"the page stating the price never reached the prompt: {extraction_content!r}"

    # And the regex pre-pass reads the same text, so the price survives even
    # when the LLM returns nothing.
    assert result["steps"]["prepass"].get("price_from") == 60
    assert result["steps"]["prepass"].get("price_to") == 260


@pytest.mark.asyncio
async def test_registration_page_is_ignored_when_a_regulamin_exists(sample_event):
    """A regulamin was read, so the registration page stays out of extraction."""
    event = _no_regulamin_event(sample_event)
    event["regulamin_url"] = "https://xrun.pl/regulamin/"

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
    ):
        mock_validate.return_value = {
            "registration_url": UrlStatus(
                url="https://xrun.pl/produkt/wielki-final-2026/", status="alive", kind="html",
            ),
            "regulamin_url": UrlStatus(
                url="https://xrun.pl/regulamin/", status="alive", kind="html",
            ),
        }
        mock_search.return_value = {}
        mock_crawl.return_value = {
            "registration_url": CrawlResult(
                url="https://xrun.pl/produkt/wielki-final-2026/",
                content=XRUN_PAGE,
                chars=len(XRUN_PAGE),
            ),
            "regulamin_url": CrawlResult(
                url="https://xrun.pl/regulamin/",
                content="Regulamin XRUN Trail Running. Opłata startowa wynosi 100 zł.",
                chars=59,
            ),
        }
        mock_prompt.return_value = "p"
        mock_llm.return_value = {}

        await process_event(event, config)

    extraction_content = mock_prompt.call_args[0][1]
    assert list(extraction_content) == ["regulamin_url"]
