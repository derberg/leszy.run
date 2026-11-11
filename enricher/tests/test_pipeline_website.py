"""The event's own `website` is read when there is no regulamin.

Kamieński Bieg Niepodległości (2026-11-11, maratonypolskie:91322) has no
registration_url and no regulamin_url. Its website is a kamienskie.info article
that says 'bieg główny na dystansie 5 kilometrów'. The pipeline never crawled
`website`, so the Step 3c fallback that reads crawled_content["website"] had
nothing to read and the row published with distances null.

VI Biegowe Grand Prix Krainy Dobrej Energii (2026-11-29, maratonypolskie:91289)
has a website that links regulamin-biegowego-grand-prix-kde-2026-2027.pdf.
Discovery seeded only from web search, so that link was never seen.
"""

import pytest
from unittest.mock import patch, AsyncMock

from enricher.pipeline import process_event
from enricher.config import Config
from enricher.steps.crawl import CrawlResult

config = Config()

KAMIEN_URL = "https://kamienskie.info/bialo-czerwony-kamien-pomorski-tak-mieszkancy-uczcza-swieto-niepodleglosci"
KAMIEN_ARTICLE = (
    "# Biało-czerwony Kamień Pomorski\n"
    "Kamieński Bieg Niepodległości 11 listopada. O 17:30 biegi dzieci w pięciu "
    "kategoriach wiekowych, o 18:30 bieg główny na dystansie 5 kilometrów oraz "
    "Nordic Walking na tej samej trasie.\n"
)


def _kamien_event(sample_event):
    sample_event["name"] = "Kamieński Bieg Niepodległości"
    sample_event["date"] = "2026-11-11"
    sample_event["location"] = "Kamień Pomorski"
    sample_event["registration_url"] = None
    sample_event["regulamin_url"] = None
    sample_event["website"] = KAMIEN_URL
    return sample_event


@pytest.mark.asyncio
async def test_website_feeds_extraction_when_no_regulamin_exists(sample_event):
    event = _kamien_event(sample_event)

    async def fake_crawl(urls, max_chars=None):
        return {
            f: CrawlResult(url=u, content=KAMIEN_ARTICLE, chars=len(KAMIEN_ARTICLE))
            for f, u in urls.items() if u == KAMIEN_URL
        }

    with (
        patch("enricher.pipeline.validate_urls", return_value={}),
        patch("enricher.pipeline.search_seed_urls", return_value=[]),
        patch("enricher.pipeline.discover_from_pages", return_value={}),
        patch("enricher.pipeline.search_missing_urls", return_value={}),
        patch("enricher.pipeline.crawl_pages", side_effect=fake_crawl),
        patch("enricher.pipeline.crawl_url_list", new_callable=AsyncMock, return_value={}),
        patch("enricher.pipeline.download_pdf", new_callable=AsyncMock, return_value=None),
        patch("enricher.pipeline.call_ollama", return_value={}),
        patch("enricher.pipeline.build_prompt", return_value="p") as mock_prompt,
    ):
        await process_event(event, config)

    extraction_content = mock_prompt.call_args[0][1]
    assert any("5 kilometrów" in v for v in extraction_content.values()), (
        f"the event's website never reached the prompt: {extraction_content!r}"
    )


@pytest.mark.asyncio
async def test_website_seeds_discovery_when_regulamin_is_missing(sample_event):
    event = sample_event
    event["name"] = "VI Biegowe Grand Prix Krainy Dobrej Ener..."
    event["date"] = "2026-11-29"
    event["regulamin_url"] = None
    event["website"] = "https://krainadobrejenergii.pl/biegowe-grand-prix/"

    with (
        patch("enricher.pipeline.validate_urls", return_value={}),
        patch("enricher.pipeline.search_seed_urls", return_value=["https://news.example.pl/a"]),
        patch("enricher.pipeline.discover_from_pages", return_value={}) as mock_discover,
        patch("enricher.pipeline.search_missing_urls", return_value={}),
        patch("enricher.pipeline.crawl_pages", new_callable=AsyncMock, return_value={}),
        patch("enricher.pipeline.crawl_url_list", new_callable=AsyncMock, return_value={}),
        patch("enricher.pipeline.call_ollama", return_value={}),
        patch("enricher.pipeline.build_prompt", return_value="p"),
    ):
        await process_event(event, config)

    seeds = mock_discover.call_args[0][1]
    assert seeds[0] == "https://krainadobrejenergii.pl/biegowe-grand-prix/"
    assert "https://news.example.pl/a" in seeds
