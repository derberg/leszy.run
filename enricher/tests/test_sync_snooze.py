"""enricher sync wakes a snoozed event the way run-publish does.

A row snoozed with no regulamin got one from `enricher sync`; run-publish then
saw the field filled and found nothing to wake, so the event stayed out of the
queue with the very data it was waiting for.
"""

from enricher.sync import wakes_snoozed

SNOOZED = {"snoozed_at": "2026-11-26T12:00:00Z", "regulamin_url": None, "distances": [], "price_from": 60}


def test_a_filled_empty_field_wakes():
    assert wakes_snoozed(SNOOZED, {"regulamin_url": "https://x.pl/r.pdf"}) is True
    assert wakes_snoozed(SNOOZED, {"distances": ["10 km"]}) is True


def test_an_overwrite_or_bookkeeping_does_not():
    assert wakes_snoozed(SNOOZED, {"price_from": 70, "enriched_at": "2026-11-27"}) is False


def test_a_row_not_snoozed_is_never_woken():
    assert wakes_snoozed({**SNOOZED, "snoozed_at": None}, {"regulamin_url": "https://x.pl"}) is False
