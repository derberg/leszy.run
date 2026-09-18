import httpx
import respx
import json
from enricher.steps.search import search_missing_urls
from enricher.config import Config


SEARXNG_RESPONSE = {
    "results": [
        {"url": "https://biegiwpolsce.pl/bieg-leszka", "title": "Bieg Leszka - biegiwpolsce"},
        {"url": "https://biegleszka.pl/zapisy", "title": "Zapisy - Bieg Leszka"},
        {"url": "https://facebook.com/biegleszka", "title": "Bieg Leszka FB"},
    ]
}

config = Config()


def test_search_returns_non_aggregator_url():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=config,
        )
    # First result is aggregator (biegiwpolsce.pl), should be skipped
    assert result.get("registration_url") == "https://biegleszka.pl/zapisy"


def test_search_skips_all_aggregators():
    all_agg = {
        "results": [
            {"url": "https://biegiwpolsce.pl/x", "title": "X"},
            {"url": "https://datasport.pl/y", "title": "Y"},
        ]
    }
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=all_agg)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=config,
        )
    assert result.get("registration_url") is None


def test_search_multiple_fields():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url", "website", "regulamin_url"],
            config=config,
        )
    # Each field gets its own search, all should find something
    assert "registration_url" in result or "website" in result


# Silesia Ultramarathon, Silesia Marathon, Silesia Half Marathon (datasport 12743,
# 2026-10-04) published with price_from and registration_deadline null. The
# organizer's "start zapisów" post outranked the five per-distance regulamin pages
# it links to, and extraction reads the regulamin only.
SILESIA_RESPONSE = {
    "results": [
        {
            "url": "https://silesiamarathon.pl/start-zapisow-silesia-marathon-2026/",
            "title": "Start zapisów Silesia Marathon 2026",
        },
        {
            "url": "https://silesiamarathon.pl/regulamin-silesia-marathon-2026/",
            "title": "Regulamin Silesia Marathon 2026",
        },
    ]
}


def test_regulamin_search_skips_a_hit_that_is_not_a_regulamin():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SILESIA_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Silesia Marathon", "date": "2026-10-04", "location": "Katowice"},
            missing_fields=["regulamin_url"],
            config=config,
        )
    assert result.get("regulamin_url") == "https://silesiamarathon.pl/regulamin-silesia-marathon-2026/"


def test_regulamin_search_returns_nothing_when_no_hit_declares_one():
    announcements = {
        "results": [
            {
                "url": "https://silesiamarathon.pl/start-zapisow-silesia-marathon-2026/",
                "title": "Start zapisów Silesia Marathon 2026",
            },
            {
                "url": "https://silesiamarathon.pl/silesia-marathon-2026-trasa/",
                "title": "Trasa Silesia Marathon 2026",
            },
        ]
    }
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=announcements)
        )
        result = search_missing_urls(
            event={"name": "Silesia Marathon", "date": "2026-10-04", "location": "Katowice"},
            missing_fields=["regulamin_url"],
            config=config,
        )
    assert result.get("regulamin_url") is None


def test_registration_search_still_takes_the_first_relevant_hit():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=config,
        )
    assert result.get("registration_url") == "https://biegleszka.pl/zapisy"


def test_search_empty_missing_fields():
    result = search_missing_urls(
        event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
        missing_fields=[],
        config=config,
    )
    assert result == {}
