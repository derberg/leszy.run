import pytest
from unittest.mock import patch

from enricher.steps.merge import build_updates
from enricher.config import Config

config = Config()


@pytest.fixture(autouse=True)
def _skip_url_verification():
    """Merge tests validate merge logic, not URL verification."""
    with patch("enricher.steps.merge.verify_url_relevance", return_value=True):
        yield


def test_fill_empty_fields(sample_event, sample_llm_response):
    """Empty fields should be filled from LLM response."""
    url_statuses = {}
    search_candidates = {}
    updates = build_updates(sample_event, sample_llm_response, url_statuses, search_candidates, config)
    assert updates["distances"] == "5 km, 10 km"
    assert updates["voivodeship"] == "Mazowieckie"
    assert updates["price_from"] == 40
    assert updates["price_to"] == 80
    assert updates["registration_deadline"] == "2026-05-01"


def test_distances_overwrite_when_more_complete(sample_event):
    """LLM found more distances → overwrite."""
    sample_event["distances"] = "10 km"
    llm = {"distances": ["5 km", "10 km", "21.1 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["distances"] == "5 km, 10 km, 21.1 km"


def test_distances_keep_when_current_has_more(sample_event):
    """Current has more distances → keep current."""
    sample_event["distances"] = "5 km, 10 km, 21.1 km"
    llm = {"distances": ["10 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "distances" not in updates


def test_distances_keep_when_same_count(sample_event):
    """Same count, different values → keep current."""
    sample_event["distances"] = "5 km, 10 km"
    llm = {"distances": ["3 km", "7 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "distances" not in updates


def test_distances_with_time_based(sample_event):
    """Time-based distances count toward total."""
    sample_event["distances"] = "10 km"
    llm = {"distances": ["10 km", "6h"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["distances"] == "10 km, 6h"


def test_event_types_additive_merge(sample_event):
    """New types added, existing kept."""
    sample_event["event_types"] = ["uliczny"]
    llm = {"distances": None, "event_types": ["uliczny", "charytatywny"]}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert set(updates["event_types"]) == {"uliczny", "charytatywny"}


def test_event_types_no_conflicting_terrain(sample_event):
    """trail + uliczny conflict → keep existing terrain."""
    sample_event["event_types"] = ["trail"]
    llm = {"distances": None, "event_types": ["uliczny", "nocny"]}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "uliczny" not in updates["event_types"]
    assert "trail" in updates["event_types"]
    assert "nocny" in updates["event_types"]


def test_dead_url_replaced_by_search_candidate(sample_event):
    """Dead URL replaced by SearXNG candidate."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"registration_url": UrlStatus(url="https://example.pl/zapisy", status="dead")}
    search_candidates = {"registration_url": "https://new.pl/zapisy"}
    llm = {"distances": None, "event_types": None, "url_is_registration": True}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert updates["registration_url"] == "https://new.pl/zapisy"


def test_url_llm_says_not_regulamin_with_candidate(sample_event):
    """LLM says regulamin_url is wrong type → replace with candidate."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive")}
    search_candidates = {"regulamin_url": "https://better.pl/regulamin.pdf"}
    llm = {"distances": None, "event_types": None, "url_is_regulamin": False}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert updates["regulamin_url"] == "https://better.pl/regulamin.pdf"


def test_url_not_nulled_without_candidate(sample_event):
    """LLM says URL is wrong type but no candidate → keep existing."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive")}
    search_candidates = {}
    llm = {"distances": None, "event_types": None, "url_is_regulamin": False}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert "regulamin_url" not in updates


def test_dead_url_not_nulled_without_candidate(sample_event):
    """Dead URL without a candidate → keep existing (don't null)."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"registration_url": UrlStatus(url="https://example.pl/zapisy", status="dead")}
    search_candidates = {}
    llm = {"distances": None, "event_types": None}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert "registration_url" not in updates


def test_scalar_overwrite(sample_event_full):
    """Scalar fields (price, deadline, voivodeship) always overwrite from LLM."""
    llm = {"distances": None, "event_types": None, "price_from": 100, "price_to": 200,
           "registration_deadline": "2026-06-10", "voivodeship": "Małopolskie"}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert updates["price_from"] == 100
    assert updates["price_to"] == 200
    assert updates["registration_deadline"] == "2026-06-10"


def test_no_changes_returns_empty(sample_event_full):
    """If LLM returns nothing useful, updates should be empty."""
    llm = {"distances": None, "event_types": None}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert len(updates) == 0


def test_deadline_wrong_year_rejected(sample_event):
    """Deadline with wrong year (>1 year from event) should be rejected."""
    llm = {"distances": None, "event_types": None, "registration_deadline": "2023-03-20"}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "registration_deadline" not in updates


def test_deadline_correct_year_accepted(sample_event):
    """Deadline within 1 year of event date should be accepted."""
    llm = {"distances": None, "event_types": None, "registration_deadline": "2026-04-01"}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["registration_deadline"] == "2026-04-01"


def test_voivodeship_not_overwritten(sample_event_full):
    """Existing voivodeship should never be overwritten by LLM."""
    llm = {"distances": None, "event_types": None, "voivodeship": "Opolskie"}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert "voivodeship" not in updates


def test_voivodeship_fills_empty(sample_event):
    """Empty voivodeship should be filled from LLM."""
    llm = {"distances": None, "event_types": None, "voivodeship": "Mazowieckie"}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["voivodeship"] == "Mazowieckie"


def test_charytatywny_not_dropped(sample_event):
    """Charytatywny should not be dropped when LLM only returns uliczny."""
    sample_event["event_types"] = ["charytatywny"]
    llm = {"distances": None, "event_types": ["uliczny", "nordic walking"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert "charytatywny" in updates["event_types"]
    assert "uliczny" in updates["event_types"]


def test_website_aggregator_blocked(sample_event):
    """Aggregator URLs should not be set as website when event already has one."""
    sample_event["website"] = "https://myevent.pl"
    llm = {"distances": None, "event_types": None, "website": "https://elektronicznezapisy.pl/event/123", "website_is_official": True}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "website" not in updates


# --- had_content=True: LLM overwrites event_types ---


def test_event_types_overwrite_when_had_content(sample_event):
    """With content, LLM types replace existing (fixes wrong scraper tags)."""
    sample_event["event_types"] = ["nocny"]
    llm = {"distances": None, "event_types": ["uliczny"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert updates["event_types"] == ["uliczny"]
    assert "nocny" not in updates["event_types"]


def test_event_types_no_downgrade_trail_to_uliczny(sample_event):
    """With content, trail should NOT be downgraded to uliczny (default fallback)."""
    sample_event["event_types"] = ["trail", "nocny"]
    llm = {"distances": None, "event_types": ["uliczny", "charytatywny"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    # trail preserved, charytatywny added, nocny kept, uliczny blocked
    assert "trail" in updates["event_types"]
    assert "charytatywny" in updates["event_types"]
    assert "nocny" in updates["event_types"]


def test_event_types_trail_plus_ocr_merged(sample_event):
    """With content, trail kept + ocr added (both are specific, neither dropped)."""
    sample_event["event_types"] = ["trail"]
    llm = {"distances": None, "event_types": ["ocr"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert set(updates["event_types"]) == {"ocr", "trail"}


def test_event_types_uliczny_to_trail_allowed(sample_event):
    """With content, upgrading uliczny to trail is allowed."""
    sample_event["event_types"] = ["uliczny"]
    llm = {"distances": None, "event_types": ["trail"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert updates["event_types"] == ["trail"]


def test_event_types_no_overwrite_without_content(sample_event):
    """Without content, additive merge keeps existing types."""
    sample_event["event_types"] = ["nocny", "uliczny"]
    llm = {"distances": None, "event_types": ["uliczny"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=False)
    assert "event_types" not in updates  # no change, LLM is subset


def test_event_types_no_change_when_same(sample_event):
    """With content, no update if LLM returns same types."""
    sample_event["event_types"] = ["uliczny"]
    llm = {"distances": None, "event_types": ["uliczny"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert "event_types" not in updates


# --- website_is_official logic ---


def test_website_news_article_not_set_when_existing(sample_event_full):
    """News article URL should not replace an existing official website."""
    llm = {"distances": None, "event_types": None, "website": "https://moje-gniezno.pl/article", "website_is_official": False}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert "website" not in updates


def test_website_official_replaces_news(sample_event):
    """Official website replaces empty website field."""
    llm = {"distances": None, "event_types": None, "website": "https://biegnij.pl", "website_is_official": True}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["website"] == "https://biegnij.pl"


def test_website_fills_empty_with_social_fallback(sample_event):
    """Social media page fills an empty website (better than nothing)."""
    llm = {"distances": None, "event_types": None, "website": "https://facebook.com/biegleszka", "website_is_official": False}
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["website"] == "https://facebook.com/biegleszka"
