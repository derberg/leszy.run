from enricher.sync import filter_locked_fields


def test_filter_locked_fields_strips_listed_keys():
    updates = {"website": "https://x.pl", "price_from": 10, "distances": ["5 km"]}
    result = filter_locked_fields(updates, locked=["website"])
    assert "website" not in result
    assert result["price_from"] == 10
    assert result["distances"] == ["5 km"]


def test_filter_locked_fields_empty_lock_is_noop():
    updates = {"website": "https://x.pl", "price_from": 10}
    assert filter_locked_fields(updates, locked=[]) == updates
    assert filter_locked_fields(updates, locked=None) == updates


def test_filter_locked_fields_unknown_lock_entries_ignored():
    updates = {"website": "https://x.pl"}
    # Extra lock entries that don't appear in updates must not error
    assert filter_locked_fields(updates, locked=["foo", "bar"]) == {"website": "https://x.pl"}


def test_filter_locked_fields_preserves_enriched_at():
    # enriched_at must always pass through — the sync needs it as the completion marker
    updates = {"website": "https://x.pl", "enriched_at": "2026-04-20T10:00:00+00:00"}
    result = filter_locked_fields(updates, locked=["website", "enriched_at"])
    assert "website" not in result
    assert result["enriched_at"] == "2026-04-20T10:00:00+00:00"
