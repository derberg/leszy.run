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


# --- Brave Search API -------------------------------------------------------

from enricher.steps import search as search_mod

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_RESPONSE = {
    "web": {
        "results": [
            {"url": "https://maratonypolskie.pl/x", "title": "Bieg Leszka", "description": ""},
            {"url": "https://biegleszka.pl/zapisy", "title": "Zapisy", "description": "Bieg Leszka 2026"},
        ]
    }
}


def _brave_config():
    search_mod._last_brave_call = 0.0
    search_mod._BRAVE_MIN_INTERVAL_S = 0
    return Config(brave_api_key="test-key")


def test_brave_used_when_key_set_and_snippet_counts_for_relevance():
    cfg = _brave_config()
    with respx.mock:
        brave = respx.get(BRAVE_URL).mock(return_value=httpx.Response(200, json=BRAVE_RESPONSE))
        searx = respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=cfg,
        )
    assert result.get("registration_url") == "https://biegleszka.pl/zapisy"
    assert brave.called and not searx.called
    assert brave.calls[0].request.headers["X-Subscription-Token"] == "test-key"


def test_brave_failure_falls_back_to_searxng():
    cfg = _brave_config()
    with respx.mock:
        respx.get(BRAVE_URL).mock(return_value=httpx.Response(429))
        searx = respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=cfg,
        )
    assert searx.called
    assert result.get("registration_url") == "https://biegleszka.pl/zapisy"


def test_brave_empty_answer_does_not_fall_back():
    cfg = _brave_config()
    with respx.mock:
        respx.get(BRAVE_URL).mock(return_value=httpx.Response(200, json={"web": {"results": []}}))
        searx = respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        result = search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=cfg,
        )
    assert not searx.called
    assert result == {}


def test_no_key_keeps_searxng():
    with respx.mock:
        brave = respx.get(BRAVE_URL).mock(return_value=httpx.Response(200, json=BRAVE_RESPONSE))
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=SEARXNG_RESPONSE)
        )
        search_missing_urls(
            event={"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa"},
            missing_fields=["registration_url"],
            config=Config(),
        )
    assert not brave.called
