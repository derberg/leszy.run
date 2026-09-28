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
from enricher.steps.verify import VerifyResult

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


# --- What the second pass is allowed to write -------------------------------
#
# The second pass runs build_updates with had_content=True, which is what makes
# the LLM authoritative: Rule 3 lets a longer distance list replace the
# scraper's, and is_kids/event_types switch from additive to overwrite. That
# authority belongs to the REGULAMIN. Pass 1 read the registration page or the
# website fallback and was merged with had_content=False on purpose — a shop
# page counts ticket variants and sibling races as distances. So only fields the
# regulamin itself answered may carry over.

# Four "distances" off a b4sport page: the two real ones plus two ticket
# variants. Longer than the scraper's list, and off a page, so nothing may
# overwrite the scraper with it.
PAGE_TICKET_VARIANTS = ["21 km", "31 km", "10 km", "5 km"]

# A rules document that states no fee and no deadline: nothing for the regex
# pre-pass to find, so a failed LLM call leaves the second pass with no answers.
REGULAMIN_NO_FIGURES = (
    "REGULAMIN Zimowego Półmaratonu Gór Stołowych\n"
    "Organizatorem jest Stowarzyszenie Biegi Gór Stołowych.\n"
    "Zapisy prowadzone są wyłącznie elektronicznie.\n"
)


def _zpgs_event_with_scraper_values(sample_event):
    """The same row, but the scraper already filled distances and is_kids."""
    event = _zpgs_event(sample_event)
    event["is_kids"] = False
    return event


@pytest.mark.asyncio
async def test_page_values_do_not_gain_regulamin_authority(sample_event):
    """Pass 1's page answers must not be re-merged as if read off the regulamin."""
    event = _zpgs_event_with_scraper_values(sample_event)

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=REGULAMIN_URL, status="alive", kind="html")},
        ]
        mock_search.return_value = {}
        mock_crawl.side_effect = _fake_crawl
        mock_prompt.return_value = "p"
        mock_llm.side_effect = [
            # Pass 1, off the b4sport page: the ticket variants and a kids guess.
            {
                "regulamin_url": REGULAMIN_URL,
                "url_is_regulamin": True,
                "distances": PAGE_TICKET_VARIANTS,
                "is_kids": True,
            },
            # Pass 2, off the regulamin: it states the fee and nothing else.
            {"price_from": 230},
        ]

        result = await process_event(event, config)

    updates = result["updates"]
    assert updates["price_from"] == 230
    # The regulamin was silent on both, so the page's answers stay page answers:
    # the scraper's two distances stand and the stored is_kids is not corrected.
    assert "distances" not in updates
    assert "is_kids" not in updates


@pytest.mark.asyncio
async def test_a_failed_second_pass_leaves_the_first_pass_result_alone(sample_event):
    """LLM down and no regex hits on the document → the second pass writes nothing."""
    event = _zpgs_event_with_scraper_values(sample_event)

    def _crawl_no_figures(urls, max_chars=10_000):
        pages = {REGISTRATION_URL: B4SPORT_PAGE, REGULAMIN_URL: REGULAMIN_NO_FIGURES}
        return {
            field: CrawlResult(url=url, content=pages[url], chars=len(pages[url]))
            for field, url in urls.items() if url in pages
        }

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=REGULAMIN_URL, status="alive", kind="html")},
        ]
        mock_search.return_value = {}
        mock_crawl.side_effect = _crawl_no_figures
        mock_prompt.return_value = "p"
        mock_llm.side_effect = [
            {
                "regulamin_url": REGULAMIN_URL,
                "url_is_regulamin": True,
                "event_types": ["trail"],
                "distances": PAGE_TICKET_VARIANTS,
                "is_kids": True,
            },
            None,  # Ollama timed out / returned junk
        ]

        result = await process_event(event, config)

    updates = result["updates"]
    # Pass 1's own findings are intact...
    assert updates["regulamin_url"] == REGULAMIN_URL
    assert updates["event_types"] == ["trail"]
    # ...and a second pass that extracted nothing did not promote them.
    assert "distances" not in updates
    assert "is_kids" not in updates


# --- Sibling-race chrome on the regulamin page ------------------------------

PCZ_REGISTRATION = "https://www.pomiaryczasu.pl/registration/ix_bieg_wolnosci_kije_2026/"
PCZ_REGULAMIN = "https://www.pomiaryczasu.pl/event/ix_bieg_wolnosci_kije_2026/regulamin/"

PCZ_REGISTRATION_PAGE = (
    '# Zapisz się na "IX Bieg Wolności Kije 2026"\n'
    f"[Regulamin]({PCZ_REGULAMIN})\n"
)

# The regulamin page carries the same "Najbliższe zawody" sidebar every other
# page on the host does — Pętla Beskidzka's 54/108 km included.
PCZ_REGULAMIN_PAGE = (
    "## Najbliższe zawody\n"
    "[ 20 czerwiec Pętla Beskidzka 2026 Dystans Mega 54 km ]"
    "(https://www.pomiaryczasu.pl/event/petla_beskidzka_2026___dystans_mega_54_km/)\n"
    "[ 20 czerwiec Pętla Beskidzka 2026 Dystans Giga 108 km ]"
    "(https://www.pomiaryczasu.pl/event/petla_beskidzka_2026___dystans_giga_108_km/)\n"
    "# REGULAMIN IX Biegu Wolności Kije 2026\n"
    "Dystanse: 10 km oraz 5,5 km. Opłata startowa: 50 zł.\n"
)


@pytest.mark.asyncio
async def test_sibling_race_chrome_is_stripped_from_the_second_pass(sample_event):
    """Step 3c's cleaning applies to the regulamin this pass fetches, too."""
    event = sample_event
    event["name"] = "IX Bieg Wolności Kije"
    event["date"] = "2026-06-21"
    event["location"] = "Kije"
    event["distances"] = "10 km, 5,5 km"
    event["registration_url"] = PCZ_REGISTRATION
    event["regulamin_url"] = None

    def _crawl(urls, max_chars=10_000):
        pages = {PCZ_REGISTRATION: PCZ_REGISTRATION_PAGE, PCZ_REGULAMIN: PCZ_REGULAMIN_PAGE}
        return {
            field: CrawlResult(url=url, content=pages[url], chars=len(pages[url]))
            for field, url in urls.items() if url in pages
        }

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=PCZ_REGISTRATION, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=PCZ_REGULAMIN, status="alive", kind="html")},
        ]
        mock_search.return_value = {}
        mock_crawl.side_effect = _crawl
        mock_prompt.return_value = "p"
        mock_llm.side_effect = [
            {"regulamin_url": PCZ_REGULAMIN, "url_is_regulamin": True},
            {"price_from": 50},
        ]

        result = await process_event(event, config)

    second_content = " ".join(mock_prompt.call_args_list[1][0][1].values())
    assert "50 zł" in second_content
    assert "54 km" not in second_content, "Pętla's distances reached the regulamin pass"
    assert "108 km" not in second_content
    assert result["updates"]["price_from"] == 50


# --- A discovered PDF still has to belong to this event ----------------------

PLATFORM_PDF = "https://elektronicznezapisy.pl/regulamin_portalu_internetowego.pdf"
PLATFORM_PDF_TEXT = (
    "REGULAMIN PORTALU INTERNETOWEGO\n"
    "Niniejszy regulamin określa zasady korzystania z serwisu.\n"
    "Opłata startowa: 99 zł. Zapisy do 01.01.2027.\n"
)


@pytest.mark.asyncio
async def test_a_platform_pdf_picked_as_the_regulamin_is_rejected(sample_event):
    """Step 4's guard on discovered PDFs applies to the one this pass opens."""
    event = _zpgs_event(sample_event)

    page = f"# Zimowy Półmaraton Gór Stołowych 2027\n[Regulamin]({PLATFORM_PDF})\n"

    def _crawl(urls, max_chars=10_000):
        return {
            field: CrawlResult(url=url, content=page, chars=len(page))
            for field, url in urls.items() if url == REGISTRATION_URL
        }

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock) as mock_download,
        patch("enricher.pipeline.extract_pdf_text", return_value=PLATFORM_PDF_TEXT),
        patch("enricher.pipeline.cleanup_pdf"),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=PLATFORM_PDF, status="alive", kind="pdf")},
        ]
        mock_search.return_value = {}
        mock_crawl.side_effect = _crawl
        mock_download.return_value = "/tmp/regulamin_portalu.pdf"
        mock_prompt.return_value = "p"
        mock_llm.side_effect = [
            {"regulamin_url": PLATFORM_PDF, "url_is_regulamin": True},
            {"price_from": 99, "registration_deadline": "2027-01-01"},
        ]

        result = await process_event(event, config)

    assert result["steps"]["regulamin_pass"]["rejected"] == "not this event"
    assert mock_llm.call_count == 1, "the portal's own regulamin reached extraction"
    assert "price_from" not in result["updates"]
    assert "registration_deadline" not in result["updates"]


# --- The same document under two spellings ----------------------------------


@pytest.mark.asyncio
async def test_a_regulamin_that_redirects_is_not_read_twice(sample_event):
    """working_urls holds the post-redirect URL, the merge step stores the raw one."""
    event = _zpgs_event(sample_event)
    raw = "http://maratongorstolowych.pl/zpgs/regulamin"  # what the page links
    final = REGULAMIN_URL  # https + www + trailing slash, after the redirect

    def _crawl(urls, max_chars=10_000):
        pages = {REGISTRATION_URL: B4SPORT_PAGE, final: REGULAMIN_DOC}
        return {
            field: CrawlResult(url=url, content=pages[url], chars=len(pages[url]))
            for field, url in urls.items() if url in pages
        }

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.pipeline.verify_search_candidate") as mock_verify,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        # Step 1 sees the registration URL; Step 2's search finds the regulamin
        # under its raw spelling and validating it follows the redirect.
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=raw, status="alive", final_url=final, kind="html")},
        ]
        mock_search.return_value = {"regulamin_url": raw}
        mock_verify.return_value = VerifyResult(
            ok=True, verdict="match", confidence=1.0, reasoning="test",
        )
        mock_crawl.side_effect = _crawl
        mock_prompt.return_value = "p"
        # The LLM restates the link as it appears on the page — the raw spelling.
        mock_llm.return_value = {
            "regulamin_url": raw, "url_is_regulamin": True, "price_from": 230,
        }

        result = await process_event(event, config)

    assert mock_crawl.call_count == 1, "the redirected regulamin was fetched twice"
    assert mock_llm.call_count == 1, "the same document was extracted twice"
    assert result["updates"]["price_from"] == 230


@pytest.mark.asyncio
async def test_a_dead_regulamin_pick_is_not_crawled(sample_event):
    """A pick that validates dead costs one HEAD, not a crawl and an LLM pass."""
    event = _zpgs_event(sample_event)

    with (
        patch("enricher.pipeline.validate_urls") as mock_validate,
        patch("enricher.pipeline.search_missing_urls") as mock_search,
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock) as mock_crawl,
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock),
        patch("enricher.pipeline.call_ollama") as mock_llm,
        patch("enricher.pipeline.build_prompt") as mock_prompt,
        patch("enricher.steps.merge.verify_url_relevance", return_value=True),
    ):
        mock_validate.side_effect = [
            {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")},
            {"regulamin_url": UrlStatus(url=REGULAMIN_URL, status="dead", error="HTTP 404")},
        ]
        mock_search.return_value = {}
        mock_crawl.side_effect = _fake_crawl
        mock_prompt.return_value = "p"
        mock_llm.return_value = {"regulamin_url": REGULAMIN_URL, "url_is_regulamin": True}

        result = await process_event(event, config)

    assert mock_crawl.call_count == 1
    assert mock_llm.call_count == 1
    assert result["steps"]["regulamin_pass"]["extracted_chars"] == 0
