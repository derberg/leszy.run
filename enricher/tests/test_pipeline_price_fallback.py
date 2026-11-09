"""Where the price comes from when the regulamin says nothing about a fee.

XIII Poranny Bieg po Plantach Krakowskich (2026-11-21, maratonypolskie:91225)
published with price_from null. Its regulamin PDF
(kardiologiaprewencyjna.eu/app/web/pdf/RegulaminBiegDlaSerca2026.pdf) names no
fee at all, the registration page is a Google Form, and the event has no
website. The only page that states the price is the organizer's own
https://kardiologiaprewencyjna.eu/page/run, which the regulamin points to
("O zmianach w Regulaminie organizator będzie informował na stronie ...") and
which ends with "Udział w biegu jest bezpłatny." The pipeline never opened it.
"""

import pytest
from unittest.mock import patch, AsyncMock

from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult

config = Config()

PDF_URL = "https://kardiologiaprewencyjna.eu/app/web/pdf/RegulaminBiegDlaSerca2026.pdf"
FORM_URL = (
    "https://docs.google.com/forms/d/e/"
    "1FAIpQLSdzFI-SSiQrY4UrwNwv3rTvDdLM-eu0Lj5PYMxT5DMjX8q20w/viewform"
)
ORGANIZER_PAGE = "https://kardiologiaprewencyjna.eu/page/run"

# The regulamin as extracted from the PDF: no fee, no "bezpłatny".
REGULAMIN_TEXT = (
    "Regulamin\n"
    "XIII PORANNEGO BIEGU PO PLANTACH KRAKOWSKICH\n"
    "I. Organizator\n"
    "Organizatorem imprezy jest Iwentarium sp. z o.o.\n"
    "III. Termin i miejsce\n"
    "21 listopada 2026 r. w Krakowie – Planty Krakowskie wejście od ulicy Siennej.\n"
    "Dystans wynosi: 4 km.\n"
    "IV. Zasady uczestnictwa\n"
    "Zgłoszenia odbywa się za pomocą formularza na pod adresem:\n"
    f"{FORM_URL}?usp=publi\nsh-editor\n"
    "V. Uwagi końcowe\n"
    "O zmianach w Regulaminie organizator będzie informował na stronie "
    f"{ORGANIZER_PAGE} ora\nzhttps://www.facebook.com/events/2882405935278024/\n"
)

FORM_PAGE = "XIII Poranny Bieg po Plantach Krakowskich\nImię i nazwisko\nE-mail\n"

ORGANIZER_PAGE_TEXT = (
    "XIII Poranny Bieg po Plantach Krakowskich\n"
    "21 listopada 2026, Planty Krakowskie, 4 km.\n"
    "REGULAMIN BIEGU\n"
    "Udział w biegu jest bezpłatny.\n"
)


def _plantach_event(sample_event):
    sample_event["name"] = "XIII Poranny Bieg po Plantach Krakowskich"
    sample_event["date"] = "2026-11-21"
    sample_event["location"] = "Kraków"
    sample_event["registration_url"] = FORM_URL
    sample_event["regulamin_url"] = PDF_URL
    sample_event["website"] = None
    return sample_event


def _patches(organizer_text=ORGANIZER_PAGE_TEXT):
    async def crawl_list(urls, max_chars=None):
        return {
            u: CrawlResult(url=u, content=organizer_text, chars=len(organizer_text))
            if u == ORGANIZER_PAGE else None
            for u in urls
        }

    return (
        patch("enricher.pipeline.validate_urls", return_value={
            "registration_url": UrlStatus(url=FORM_URL, status="alive", kind="html"),
            "regulamin_url": UrlStatus(url=PDF_URL, status="alive", kind="pdf"),
        }),
        patch("enricher.pipeline.search_missing_urls", return_value={}),
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock, return_value={
            "registration_url": CrawlResult(url=FORM_URL, content=FORM_PAGE, chars=len(FORM_PAGE)),
        }),
        patch("enricher.pipeline.crawl_url_list", side_effect=crawl_list),
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock, return_value="/tmp/x.pdf"),
        patch("enricher.pipeline.extract_pdf_text", return_value=REGULAMIN_TEXT),
        patch("enricher.pipeline.cleanup_pdf"),
        patch("enricher.pipeline.call_ollama", return_value={}),
    )


@pytest.mark.asyncio
async def test_free_race_stated_on_the_page_the_regulamin_links(sample_event):
    """A fee-silent regulamin falls back to its organizer page for the price."""
    event = _plantach_event(sample_event)
    p = _patches()
    with p[0], p[1], p[2], p[3] as mock_crawl_list, p[4], p[5], p[6], p[7]:
        result = await process_event(event, config)

    crawled = [u for call in mock_crawl_list.call_args_list for u in call.args[0]]
    assert ORGANIZER_PAGE in crawled, f"the organizer page was never opened: {crawled!r}"
    assert result["updates"].get("price_from") == 0
    assert result["updates"].get("price_to") == 0


@pytest.mark.asyncio
async def test_other_hosts_in_the_regulamin_are_not_price_sources(sample_event):
    """Only a page on the regulamin's own host is read; Facebook/Maps/Forms are not."""
    event = _plantach_event(sample_event)
    p = _patches()
    with p[0], p[1], p[2], p[3] as mock_crawl_list, p[4], p[5], p[6], p[7]:
        await process_event(event, config)

    crawled = [u for call in mock_crawl_list.call_args_list for u in call.args[0]]
    assert all(u.startswith("https://kardiologiaprewencyjna.eu/") for u in crawled), crawled


@pytest.mark.asyncio
async def test_a_regulamin_that_states_the_fee_is_not_overruled(sample_event):
    """The regulamin's own fee wins; the organizer page is not even fetched."""
    event = _plantach_event(sample_event)
    p = _patches()
    with (
        p[0], p[1], p[2], p[3] as mock_crawl_list, p[4],
        patch("enricher.pipeline.extract_pdf_text",
              return_value=REGULAMIN_TEXT + "Opłata startowa wynosi 30 zł.\n"),
        p[6], p[7],
    ):
        result = await process_event(event, config)

    crawled = [u for call in mock_crawl_list.call_args_list for u in call.args[0]]
    assert ORGANIZER_PAGE not in crawled
    assert result["updates"].get("price_from") == 30
