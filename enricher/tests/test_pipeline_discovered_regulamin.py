"""A regulamin discovered during the run has to be read during the same run.

ZPGS 2027 (2027-01-16, b4sport:13127) published with price_from and
registration_deadline null even though enriched_at was stamped
2026-09-28T14:18:07. The b4sport registration page was the only thing crawled
(run-2026-09-28T135646.jsonl: crawl 1 page, clean fallback_sources
["registration_url"], prepass {}), the LLM read it and named a regulamin link on
it, and the merge step wrote that link (merge fields_replaced
["regulamin_url"]). Nothing opened the document. The row then carried
enriched_at, so fetch_events' default query (enriched_at IS NULL) never came
back for it.

The regulamin lists 230 zł for the 21 km and a 14.01.2027 payment deadline.
"""

import pytest
from unittest.mock import patch, AsyncMock

from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult

config = Config()

REGISTRATION_URL = (
    "https://b4sportonline.pl/Zimowy_Polmaraton_Gor_Stolowych/"
    "zapisy_na_biala_trzydziestka_31km__2027/13127"
)
REGULAMIN_URL = "https://www.maratongorstolowych.pl/zpgs/regulamin/"

# b4sport keeps the fee behind its own checkout, so the registration page states
# no price and no deadline. It does link the organizer's regulamin.
B4SPORT_PAGE = (
    "# Zimowy Półmaraton Gór Stołowych 2027\n"
    "Zapisy na Biała Trzydziestka 31 km\n"
    f"Regulamin: {REGULAMIN_URL}\n"
)

REGULAMIN_DOC = (
    "REGULAMIN Zimowego Półmaratonu Gór Stołowych 2027\n"
    "Opłata startowa 21 km: 230 zł (pierwszych 150 pakietów), 255 zł, 280 zł\n"
    "Opłata startowa 31 km: 250 zł, 275 zł, 300 zł\n"
    "Wpłata na konto organizatora po wskazanym terminie (14.01.2027 r.) "
    "nie gwarantuje udziału.\n"
)


def _zpgs_event(sample_event):
    """The b4sport row as it stood before the 2026-09-28 run: no regulamin."""
    sample_event["name"] = "Zimowy Półmaraton Gór Stołowych"
    sample_event["date"] = "2027-01-16"
    sample_event["location"] = "Kudowa-Zdrój"
    sample_event["distances"] = "21 km, 31 km"
    sample_event["registration_url"] = REGISTRATION_URL
    sample_event["regulamin_url"] = None
    return sample_event


def _fake_crawl(urls, max_chars=10_000):
    pages = {REGISTRATION_URL: B4SPORT_PAGE, REGULAMIN_URL: REGULAMIN_DOC}
    out = {}
    for field, url in urls.items():
        content = pages.get(url)
        if content:
            out[field] = CrawlResult(url=url, content=content, chars=len(content))
    return out


@pytest.mark.asyncio
async def test_regulamin_found_by_the_llm_is_read_in_the_same_pass(sample_event):
    """The LLM names a regulamin off the registration page → open it and extract."""
    event = _zpgs_event(sample_event)

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        # Step 1 sees the registration URL only; the second call classifies the
        # regulamin the merge step picked.
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=REGULAMIN_URL, status="alive", kind="html")},
        ]
        mock_search.return_value = {}  # SearXNG found nothing, as in the real run
        mock_crawl.side_effect = _fake_crawl
        mock_prompt.return_value = "p"
        mock_llm.side_effect = [
            # Pass 1 reads the registration page: no fee printed there, but it
            # carries the regulamin link.
            {
                "regulamin_url": REGULAMIN_URL,
                "url_is_regulamin": True,
                "event_types": ["uliczny"],
            },
            # Pass 2 reads the regulamin itself.
            {"price_from": 230, "price_to": 300, "registration_deadline": "2027-01-14"},
        ]

        result = await process_event(event, config)

    mock_download.assert_not_called()
    assert mock_crawl.call_count == 2, "the discovered regulamin was never fetched"

    # The second prompt was built from the regulamin, not the registration page.
    second_content = mock_prompt.call_args_list[1][0][1]
    assert "230 zł" in " ".join(second_content.values())

    updates = result["updates"]
    assert updates["regulamin_url"] == REGULAMIN_URL
    assert updates["price_from"] == 230
    assert updates["registration_deadline"] == "2027-01-14"
    # Pass 1's own findings survive the second pass.
    assert updates["event_types"] == ["uliczny"]


@pytest.mark.asyncio
async def test_regulamin_already_read_is_not_fetched_twice(sample_event):
    """The event's own regulamin fed extraction → no second fetch, no second LLM call."""
    event = _zpgs_event(sample_event)
    event["regulamin_url"] = REGULAMIN_URL

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        mock_validate.return_value = {
            "registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html"),
            "regulamin_url": UrlStatus(url=REGULAMIN_URL, status="alive", kind="html"),
        }
        mock_search.return_value = {}
        mock_crawl.side_effect = _fake_crawl
        mock_prompt.return_value = "p"
        mock_llm.return_value = {
            "regulamin_url": REGULAMIN_URL,
            "url_is_regulamin": True,
            "price_from": 230,
        }

        result = await process_event(event, config)

    mock_download.assert_not_called()
    assert mock_crawl.call_count == 1
    assert mock_llm.call_count == 1
    assert result["updates"]["price_from"] == 230
