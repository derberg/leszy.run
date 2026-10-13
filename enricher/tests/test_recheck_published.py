"""A published event that is still incomplete has to be read again.

The default run only picks rows with enriched_at IS NULL, so a row enriched once
was never revisited. 47. Półmaraton Wiązowski (datasport:12859, 2027-02-28) was
enriched on 2026-10-13, before the organizer had uploaded the rules, and nothing
would ever have read it again. On that day 58 future calendar_events rows failed
the approval bar.
"""

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from enricher.pipeline import REQUIRED_FIELDS, missing_required, select_rechecks

NOW = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)
OLD = (NOW - timedelta(days=8)).isoformat()
FRESH = (NOW - timedelta(days=2)).isoformat()

COMPLETE = {
    "location": "Wiązowna",
    "voivodeship": "Mazowieckie",
    "event_type": ["uliczny"],
    "distances": ["21.1 km"],
    "registration_url": "https://example.pl/zapisy",
    "regulamin_url": "https://example.pl/regulamin.pdf",
    "registration_deadline": "2027-02-20",
    "price_from": 99,
}


def ce(source_id, status="pending", **fields):
    row = {**COMPLETE, "source": "datasport", "source_id": source_id,
           "status": status, "source_links": [], "locked_fields": []}
    row.update(fields)
    return row


def sa(source_id, enriched_at=OLD, source="datasport"):
    return {"id": f"sa-{source_id}", "source": source, "source_id": source_id,
            "enriched_at": enriched_at}


def test_required_fields_match_the_shared_definition():
    js = Path(__file__).resolve().parents[2] / "packages/ui/src/lib/eventCompleteness.js"
    block = re.search(r"REQUIRED_FIELDS = \[(.*?)\]", js.read_text(), re.S).group(1)
    assert tuple(re.findall(r"'([a-z_]+)'", block)) == REQUIRED_FIELDS


def test_missing_required_respects_brak_locks_and_free_races():
    assert missing_required(ce("1", regulamin_url=None)) == ["regulamin_url"]
    assert missing_required(ce("1", regulamin_url=None, locked_fields=["regulamin_url"])) == []
    assert missing_required(ce("1", price_from=0)) == []
    assert missing_required(ce("1", distances=[], location="  ")) == ["location", "distances"]


def test_incomplete_published_row_enriched_a_week_ago_is_rechecked():
    picked = select_rechecks([sa("12859")], [ce("12859", regulamin_url=None)], NOW)
    assert [r["id"] for r in picked] == ["sa-12859"]


def test_recently_enriched_row_waits():
    assert select_rechecks([sa("12859", FRESH)], [ce("12859", price_from=None)], NOW) == []


def test_complete_rejected_and_unpublished_rows_are_left_alone():
    rows = [sa("1"), sa("2"), sa("3")]
    ces = [ce("1"), ce("2", status="rejected", regulamin_url=None)]
    assert select_rechecks(rows, ces, NOW) == []


def test_row_matched_through_source_links():
    row = ce("90509", source="maratonypolskie", price_from=None,
             source_links=[{"source": "datasport", "source_id": "12861"}])
    assert [r["id"] for r in select_rechecks([sa("12861")], [row], NOW)] == ["sa-12861"]
