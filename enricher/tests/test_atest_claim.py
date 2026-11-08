"""The course atest the regulamin claims (scraper_all.atest_claim).

The backend's run-atest.js publishes an atest only where the PZLA register backs
it, and reads this claim to decide: a regulamin "yes" lifts a looser register
match, a regulamin "no" overrules the register. So a guessed answer here would
reach the race page. The claim is written only from a document that talks about
certification, and only from a regulamin, never the registration-page fallback.
"""

import pytest
from unittest.mock import patch, AsyncMock

from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.merge import atest_claim_from
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult

config = Config()

WITH_ATEST = "Regulamin. Trasa posiada atest PZLA. Opłata startowa wynosi 60 zł."
WITHOUT_WORD = "Regulamin. Bieg na 10 km ulicami miasta. Opłata startowa wynosi 60 zł."


def test_a_stated_atest_is_kept_with_its_distances():
    assert atest_claim_from({"certified": True, "distances_km": [10, "21,0975"]}, [WITH_ATEST]) == {
        "certified": True,
        "distances_km": [10.0, 21.0975],
    }


def test_a_stated_no_is_kept_too():
    text = "Regulamin. Trasa nie posiada atestu PZLA."
    assert atest_claim_from({"certified": False, "distances_km": []}, [text]) == {
        "certified": False,
        "distances_km": [],
    }


def test_an_answer_the_document_cannot_support_is_dropped():
    assert atest_claim_from({"certified": True, "distances_km": []}, [WITHOUT_WORD]) is None


def test_silence_or_junk_writes_nothing():
    assert atest_claim_from({"certified": None, "distances_km": []}, [WITH_ATEST]) is None
    assert atest_claim_from(None, [WITH_ATEST]) is None
    assert atest_claim_from({"certified": "yes"}, [WITH_ATEST]) is None
    assert atest_claim_from({"certified": True, "distances_km": ["abc", -5]}, [WITH_ATEST]) == {
        "certified": True,
        "distances_km": [],
    }


async def _run(sample_event, crawled, llm_answer):
    sample_event["registration_url"] = "https://example-race.pl/zapisy/"
    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt", return_value="p"),
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        statuses = {
            "registration_url": UrlStatus(url="https://example-race.pl/zapisy/", status="alive", kind="html"),
        }
        if "regulamin_url" in crawled:
            statuses["regulamin_url"] = UrlStatus(url=sample_event["regulamin_url"], status="alive", kind="html")
        mock_validate.return_value = statuses
        mock_search.return_value = {}
        mock_crawl.return_value = crawled
        mock_llm.return_value = llm_answer
        return await process_event(sample_event, config)


@pytest.mark.asyncio
async def test_the_pipeline_writes_the_claim_read_from_a_regulamin(sample_event):
    sample_event["regulamin_url"] = "https://example-race.pl/regulamin/"
    crawled = {
        "regulamin_url": CrawlResult(url=sample_event["regulamin_url"], content=WITH_ATEST, chars=len(WITH_ATEST)),
    }
    result = await _run(sample_event, crawled, {"atest": {"certified": True, "distances_km": [10]}})
    assert result["updates"]["atest_claim"] == {"certified": True, "distances_km": [10.0]}


@pytest.mark.asyncio
async def test_the_registration_page_fallback_never_writes_a_claim(sample_event):
    sample_event["regulamin_url"] = None
    crawled = {
        "registration_url": CrawlResult(url="https://example-race.pl/zapisy/", content=WITH_ATEST, chars=len(WITH_ATEST)),
    }
    result = await _run(sample_event, crawled, {"atest": {"certified": True, "distances_km": []}})
    assert "atest_claim" not in result["updates"]
