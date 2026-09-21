import pytest
from unittest.mock import patch

from enricher.steps.merge import build_updates
from enricher.steps.validate_urls import UrlStatus
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
    """The regulamin lists more distances than the scraper, so it overwrites."""
    sample_event["distances"] = "10 km"
    llm = {"distances": ["5 km", "10 km", "21.1 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
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
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
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


def test_populated_scalars_are_not_overwritten(sample_event_full):
    """Price, deadline and voivodeship are fill-if-empty, not overwrite.

    The scraper reads these off the organizer's own registration system, so they beat an
    LLM reading prose. This test previously asserted the opposite ("always overwrite") and
    had been failing since price and deadline were changed to fill-if-empty; it now
    documents the rule the code actually implements.
    """
    llm = {"distances": None, "event_types": None, "price_from": 100, "price_to": 200,
           "registration_deadline": "2026-06-10", "voivodeship": "Małopolskie"}
    updates = build_updates(sample_event_full, llm, {}, {}, config)
    assert "price_from" not in updates
    assert "price_to" not in updates
    assert "registration_deadline" not in updates
    assert "voivodeship" not in updates


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


# --- website is no longer enriched ---


def test_website_never_written(sample_event):
    """`website` is intentionally dropped from enrichment — the merge step must
    never emit it, regardless of what the LLM returns."""
    llm = {
        "distances": None, "event_types": None,
        "website": "https://biegnij.pl", "website_is_official": True,
    }
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "website" not in updates


def test_provisional_zero_price_is_overwritten_by_regulamin(sample_event):
    """A scraper-written 0 means 'dostartu collects nothing', not 'the race is free'.

    Competition 16696 reports classificationSetting.isPay:false for every entry while its
    regulamin charges 50 zł in cash at the race office. The regulamin is the document that
    states the real fee, so it must be able to overrule a 0.
    """
    event = {**sample_event, "price_from": 0, "price_to": 0}
    llm = {"distances": None, "event_types": None, "price_from": 50, "price_to": 50,
           "registration_deadline": None, "voivodeship": None, "is_kids": None}
    updates = build_updates(event, llm, {}, {}, config)
    assert updates["price_from"] == 50
    assert updates["price_to"] == 50


def test_nonzero_scraper_price_still_wins_over_llm(sample_event):
    """Only 0 is provisional — a real scraper price stays authoritative."""
    event = {**sample_event, "price_from": 60, "price_to": 90}
    llm = {"distances": None, "event_types": None, "price_from": 50, "price_to": 50,
           "registration_deadline": None, "voivodeship": None, "is_kids": None}
    updates = build_updates(event, llm, {}, {}, config)
    assert "price_from" not in updates
    assert "price_to" not in updates


def test_zero_price_survives_when_regulamin_names_no_fee(sample_event):
    """A genuinely free event keeps its 0 — the LLM returning null must not clear it."""
    event = {**sample_event, "price_from": 0, "price_to": 0}
    llm = {"distances": None, "event_types": None, "price_from": None, "price_to": None,
           "registration_deadline": None, "voivodeship": None, "is_kids": None}
    updates = build_updates(event, llm, {}, {}, config)
    assert "price_from" not in updates
    assert "price_to" not in updates


def test_one_sided_price_lift_off_zero_is_rejected(sample_event):
    """Lifting price_from off 0 while price_to stays 0 would leave an inverted range."""
    event = {**sample_event, "price_from": 0, "price_to": 0}
    llm = {"distances": None, "event_types": None, "price_from": 50, "price_to": None,
           "registration_deadline": None, "voivodeship": None, "is_kids": None}
    updates = build_updates(event, llm, {}, {}, config)
    assert "price_from" not in updates
    assert "price_to" not in updates


# A bare origin is a homepage, never a sign-up form or a rules document.
# Regression: BIEGAM, BO LUBIĘ LASY - Lubartów (inessport gr330). The listing
# page had no "Formularz zgłoszenia" button yet — registration opened that
# evening — so the scraper stored null. The regulamin says "Zapisy online na
# stronie zapisy.inessport.pl", the LLM returned that bare domain, and
# verify_url_relevance passed it: the bare domain serves the full inesSport
# listing, which carries every event name including this one. An event-name
# check can never reject a listing root, so the shape has to be rejected first.

def test_bare_origin_rejected_as_registration_url(sample_event):
    """A path-less domain from the regulamin must not fill registration_url."""
    sample_event["registration_url"] = None
    llm = {
        "distances": None,
        "event_types": None,
        "registration_url": "https://zapisy.inessport.pl",
        "url_is_registration": True,
    }
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "registration_url" not in updates


def test_bare_origin_with_trailing_slash_rejected(sample_event):
    """Trailing slash is still a homepage."""
    sample_event["registration_url"] = None
    llm = {
        "distances": None,
        "event_types": None,
        "registration_url": "https://zapisy.inessport.pl/",
        "url_is_registration": True,
    }
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "registration_url" not in updates


def test_bare_origin_rejected_from_search_candidate(sample_event):
    """The same shape reaching via the search step is rejected too."""
    sample_event["registration_url"] = None
    llm = {"distances": None, "event_types": None}
    updates = build_updates(
        sample_event, llm, {}, {"registration_url": "https://zapisy.inessport.pl/"}, config
    )
    assert "registration_url" not in updates


def test_bare_origin_rejected_as_regulamin_url(sample_event):
    """A rules document does not live at a bare origin either."""
    sample_event["regulamin_url"] = None
    llm = {
        "distances": None,
        "event_types": None,
        "regulamin_url": "https://zapisy.inessport.pl",
        "url_is_regulamin": True,
    }
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert "regulamin_url" not in updates


def test_bare_origin_does_not_replace_a_dead_url(sample_event):
    """A dead URL stays put rather than degrading to a homepage."""
    url_statuses = {"registration_url": UrlStatus(url="https://example.pl/zapisy", status="dead")}
    llm = {
        "distances": None,
        "event_types": None,
        "registration_url": "https://zapisy.inessport.pl",
        "url_is_registration": True,
    }
    updates = build_updates(sample_event, llm, url_statuses, {}, config)
    assert "registration_url" not in updates


def test_query_only_url_still_accepted(sample_event):
    """inesSport's real form lives at a query string on the listing path."""
    sample_event["registration_url"] = None
    real = "https://zapisy.inessport.pl/index.php?idm=5&idp=0&act=zgloszenie-zawodnika&event=1504"
    llm = {
        "distances": None,
        "event_types": None,
        "registration_url": real,
        "url_is_registration": True,
    }
    updates = build_updates(sample_event, llm, {}, {}, config)
    assert updates["registration_url"] == real


def test_distances_not_overwritten_without_regulamin(sample_event):
    """No regulamin was read, so the page cannot rewrite the scraper's distances.

    The registration-page fallback exists to recover a fee the organizer states
    nowhere else. The page it reads is a sign-up form or a shop listing, and the
    numbers on one of those belong to ticket variants as often as to races. The
    scraper read the event listing, so its distances outrank anything counted off
    such a page.
    """
    sample_event["distances"] = "10 km"
    llm = {"distances": ["5 km", "10 km", "21.1 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=False)
    assert "distances" not in updates


def test_distances_filled_from_fallback_when_empty(sample_event):
    """An empty field is still filled: there is nothing to protect."""
    sample_event["distances"] = None
    llm = {"distances": ["5 km", "10 km"], "event_types": None}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=False)
    assert updates["distances"] == "5 km, 10 km"
