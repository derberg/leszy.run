"""A sibling race's regulamin must not enrich this race, nor any PDF the run does not keep.

Letni Ultra Świr (biegigorskie, 2027-08-27, Ptaszkowa; 48h/24h/12h/6h and a
15,5 km nordic walking) declares an HTML regulamin. The 2026-11-25 run crawled
its 2026 b4sport registration page, which lists every file of the organizer's
folder, and read Regulamin_Wyspowy_Ultra_Swir_2027.pdf: the regulamin of
Wyspowy Ultra Świr (2027-06-26, Łącko, 65/43/23 km). pdf_belongs_to_event let
it through on the shared "Świr", the LLM wrote 65/43/23 km and 90-300 zł, and
the PDF's URL was stored nowhere, because Step 4 offers a discovered PDF as a
candidate only when the event has no regulamin.
"""

import pytest
from unittest.mock import patch, AsyncMock

from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.validate_urls import UrlStatus
from enricher.steps.crawl import CrawlResult
from enricher.steps.navigate import pdf_belongs_to_event, names_a_sibling_race

config = Config()

LETNI = {"name": "Letni Ultra Świr", "date": "2027-08-27", "location": "Ptaszkowa"}

# The first lines of the real PDF (pdftotext -layout, 2026-11-25).
WYSPOWY_PDF = (
    "REGULAMIN\n"
    "REGULAMIN BIEGÓW GÓRSKICH – Wyspowy Ultra Świr\n"
    "1. ORGANIZATOR\n"
    "Organizatorem biegów górskich WYSPOWY ULTRA ŚWIR jest fundacja:\n"
    "FUNDACJA „MAŁOPOLSKA BIEGA”\n"
    "3. DATA I MIEJSCE\n"
    "Biegi odbędą się w terminie 26.06.2027\n"
    "- start biegu 65 km -26.06.2026 godz.6:00- limit czasu 14 godzin\n"
    "– start biegu na dystansie 43 km – 26.06.2027 godz. 9:00\n"
    "– start biegu dystansie 23 km – 26.06.2027 godz 10:00\n"
    "Opłata startowa: 90 zł – 300 zł\n"
)


# --- Defect 1: the sibling passes the belongs-to-event test -----------------

def test_sibling_race_of_the_series_is_rejected():
    assert names_a_sibling_race(LETNI, WYSPOWY_PDF) is True
    assert pdf_belongs_to_event(LETNI, WYSPOWY_PDF) is False


def test_the_race_own_regulamin_is_kept():
    own = "REGULAMIN BIEGÓW GÓRSKICH – Letni Ultra Świr\nBiegi 48h, 24h, 12h, 6h.\n"
    assert pdf_belongs_to_event(LETNI, own) is True


def test_a_declined_lead_word_is_the_same_race():
    own = "Regulamin Letniego Ultra Świra 2027\nStart: Ptaszkowa.\n"
    assert pdf_belongs_to_event(LETNI, own) is True


def test_a_series_regulamin_titled_with_the_core_only_is_kept():
    # No other race named in the title: "Regulamin" stands before the core.
    doc = "REGULAMIN Ultra Świr 2027\nBiegi w Ptaszkowej, 48h i 24h.\n"
    assert pdf_belongs_to_event(LETNI, doc) is True


def test_a_sibling_named_below_the_title_does_not_reject():
    # A series calendar further down names the other races; the title is ours.
    doc = (
        "REGULAMIN – Ultra Świr\n" + "Organizator: Fundacja Małopolska Biega.\n" * 10
        + "Cykl: Wiosenny Ultra Świr, Wyspowy Ultra Świr.\n"
    )
    assert pdf_belongs_to_event(LETNI, doc) is True


def test_name_starting_with_a_generic_word_is_never_judged():
    # A town missing from a regulamin is common; the rule does not look at it.
    event = {"name": "Bieg Niepodległości Ryki"}
    doc = "Regulamin Biegu Niepodległości Ziemi Ryckiej\nDystans 10 km.\n"
    assert names_a_sibling_race(event, doc) is False


def test_one_letter_typo_in_the_lead_word_is_not_a_sibling():
    event = {"name": "Kampinoskie Ultra Świr"}
    doc = "REGULAMIN Kampinoskie Ultra Świr\n"
    assert names_a_sibling_race(event, doc.replace("Kampinoskie", "Kampinoski")) is False


# --- Defect 2: a PDF the run does not keep must not feed extraction ---------

REGISTRATION_URL = (
    "https://b4sportonline.pl/ultra_swir/"
    "zapisy_na_letni_ultra_swir_marsz_nordic_walking_17_km_2026"
)
REGULAMIN_URL = "https://malopolskabiega.com.pl/regulamin-ultra/"
FOLDER_PDF = "https://b4sportonline.pl/users-folder/1104/files/Regulamin_Letni_Ultra_Swir_2027.pdf"
# A document the belongs-to-event test accepts, so only the second guard can stop it.
PASSING_PDF = "REGULAMIN Letni Ultra Świr 2027\nDystanse: 65 km, 43 km, 23 km.\nOpłata 90-300 zł\n"


def _event(sample_event, regulamin_url=REGULAMIN_URL):
    sample_event.update(LETNI)
    sample_event["registration_url"] = REGISTRATION_URL
    sample_event["regulamin_url"] = regulamin_url
    sample_event["distances"] = None
    return sample_event


def _run(event, statuses, pages, links, pdf_text=PASSING_PDF):
    """process_event with the network mocked; links maps a page URL to the PDFs it links."""

    async def fake_crawl(urls, max_chars=10_000):
        return {
            f: CrawlResult(url=u, content=pages[u], chars=len(pages[u]))
            for f, u in urls.items() if u in pages
        }

    def fake_pick(base_url, **_):
        return links.get(base_url, [])

    return (
        patch("enricher.pipeline.validate_urls", return_value=statuses),
        patch("enricher.pipeline.search_missing_urls", return_value={}),
        patch("enricher.pipeline.search_seed_urls", return_value=[]),
        patch("enricher.pipeline.crawl_pages", new=AsyncMock(side_effect=fake_crawl)),
        patch("enricher.pipeline.crawl_url_list", new=AsyncMock(return_value={})),
        patch("enricher.pipeline.pick_followup_urls", side_effect=fake_pick),
        patch("enricher.pipeline.download_pdf", new=AsyncMock(return_value="/tmp/x.pdf")),
        patch("enricher.pipeline.extract_pdf_text", return_value=pdf_text),
        patch("enricher.pipeline.cleanup_pdf"),
        patch("enricher.pipeline.call_ollama", return_value={"price_from": 90}),
        patch("enricher.pipeline.build_prompt", return_value="p"),
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    )


async def _process(event, *mocks):
    from contextlib import ExitStack
    with ExitStack() as stack:
        entered = [stack.enter_context(m) for m in mocks]
        result = await process_event(event, config)
    by_name = {m.attribute: e for m, e in zip(mocks, entered)}
    return result, by_name


@pytest.mark.asyncio
async def test_pdf_from_the_registration_page_is_not_read_when_the_event_has_a_regulamin(sample_event):
    event = _event(sample_event)
    statuses = {
        "registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html"),
        "regulamin_url": UrlStatus(url=REGULAMIN_URL, status="alive", kind="html"),
    }
    pages = {REGISTRATION_URL: "# Zapisy Letni Ultra Świr", REGULAMIN_URL: "Regulamin Ultra Świr"}
    result, m = await _process(event, *_run(event, statuses, pages, {REGISTRATION_URL: [FOLDER_PDF]}))

    m["download_pdf"].assert_not_called()
    assert m["build_prompt"].call_args[0][2] is None, "the PDF's text reached the prompt"
    assert result["steps"]["pdf_skipped"] == [FOLDER_PDF]
    assert "regulamin_url" not in result["updates"]


@pytest.mark.asyncio
async def test_pdf_linked_from_the_event_regulamin_page_is_read(sample_event):
    event = _event(sample_event)
    statuses = {
        "registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html"),
        "regulamin_url": UrlStatus(url=REGULAMIN_URL, status="alive", kind="html"),
    }
    pages = {REGISTRATION_URL: "# Zapisy", REGULAMIN_URL: "Regulamin do pobrania"}
    result, m = await _process(event, *_run(event, statuses, pages, {REGULAMIN_URL: [FOLDER_PDF]}))

    m["download_pdf"].assert_called_once_with(FOLDER_PDF)
    assert m["build_prompt"].call_args[0][2] == PASSING_PDF
    assert result["updates"].get("regulamin_url") is None  # the declared page stays


@pytest.mark.asyncio
async def test_pdf_is_read_and_stored_when_the_event_has_no_regulamin(sample_event):
    event = _event(sample_event, regulamin_url=None)
    statuses = {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")}
    pages = {REGISTRATION_URL: "# Zapisy"}
    result, m = await _process(event, *_run(event, statuses, pages, {REGISTRATION_URL: [FOLDER_PDF]}))

    assert m["build_prompt"].call_args[0][2] == PASSING_PDF
    assert result["updates"]["regulamin_url"] == FOLDER_PDF


@pytest.mark.asyncio
async def test_pdf_replaces_a_dead_regulamin_it_was_read_for(sample_event):
    dead = "https://malopolskabiega.com.pl/stary-regulamin/"
    event = _event(sample_event, regulamin_url=dead)
    statuses = {
        "registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html"),
        "regulamin_url": UrlStatus(url=dead, status="dead", kind="html"),
    }
    pages = {REGISTRATION_URL: "# Zapisy"}
    result, m = await _process(event, *_run(event, statuses, pages, {REGISTRATION_URL: [FOLDER_PDF]}))

    assert m["build_prompt"].call_args[0][2] == PASSING_PDF
    assert result["updates"]["regulamin_url"] == FOLDER_PDF


@pytest.mark.asyncio
async def test_the_sibling_pdf_is_rejected_where_it_would_be_offered(sample_event):
    event = _event(sample_event, regulamin_url=None)
    statuses = {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")}
    pages = {REGISTRATION_URL: "# Zapisy"}
    sibling = "https://b4sportonline.pl/users-folder/1104/files/Regulamin_Wyspowy_Ultra_Swir_2027.pdf"
    result, m = await _process(
        event, *_run(event, statuses, pages, {REGISTRATION_URL: [sibling]}, pdf_text=WYSPOWY_PDF)
    )

    assert m["build_prompt"].call_args[0][2] is None
    assert result["steps"]["pdf_rejected"] == [sibling]
    assert "regulamin_url" not in result["updates"]
