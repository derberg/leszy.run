from enricher.steps.merge import build_updates
from enricher.config import Config

config = Config()


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


def test_url_llm_says_not_regulamin(sample_event):
    """LLM says regulamin_url is not actually a regulamin → null it."""
    from enricher.steps.validate_urls import UrlStatus
    url_statuses = {"regulamin_url": UrlStatus(url="https://example.pl/regulamin.pdf", status="alive")}
    search_candidates = {}
    llm = {"distances": None, "event_types": None, "url_is_regulamin": False}
    updates = build_updates(sample_event, llm, url_statuses, search_candidates, config)
    assert updates["regulamin_url"] is None


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


# --- had_content=True: LLM overwrites event_types ---


def test_event_types_overwrite_when_had_content(sample_event):
    """With content, LLM types replace existing (fixes wrong scraper tags)."""
    sample_event["event_types"] = ["nocny"]
    llm = {"distances": None, "event_types": ["uliczny"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert updates["event_types"] == ["uliczny"]
    assert "nocny" not in updates["event_types"]


def test_event_types_overwrite_removes_wrong_terrain(sample_event):
    """With content, LLM can replace trail with uliczny."""
    sample_event["event_types"] = ["trail", "nocny"]
    llm = {"distances": None, "event_types": ["uliczny", "charytatywny"]}
    updates = build_updates(sample_event, llm, {}, {}, config, had_content=True)
    assert set(updates["event_types"]) == {"charytatywny", "uliczny"}


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
