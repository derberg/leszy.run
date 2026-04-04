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


def test_search_empty_missing_fields():
    result = search_missing_urls(
        event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
        missing_fields=[],
        config=config,
    )
    assert result == {}
