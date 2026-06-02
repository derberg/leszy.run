"""Tests for the content-cleaning guards that prevent cross-event contamination:
- strip_foreign_event_lines: removes sibling-race "upcoming events" chrome
- page_matches_event: gates wrong-event SearXNG hits
"""
from enricher.steps.navigate import (
    strip_foreign_event_lines,
    page_matches_event,
    _distinctive_tokens,
)

# Real shape of a pomiaryczasu page body (markdown), as crawled. The
# "Najbliższe zawody" sidebar lists sibling races with their distances.
PCZ_PAGE = """## Najbliższe zawody
[ 20 czerwiec Pętla Beskidzka 2026 - Memoriał Jana Ferdyna Dystans Mega 54 km ](https://www.pomiaryczasu.pl/event/petla_beskidzka_2026___memorial_jana_ferdyna_dystans_mega_54_km/) [Zapisz się](https://www.pomiaryczasu.pl/registration/petla_beskidzka_2026___memorial_jana_ferdyna_dystans_mega_54_km/)
[ 20 czerwiec Pętla Beskidzka 2026 - Memoriał Jana Ferdyna Dystans Giga 108 km ](https://www.pomiaryczasu.pl/event/petla_beskidzka_2026___memorial_jana_ferdyna_dystans_giga_108_km/) [Zapisz się](https://www.pomiaryczasu.pl/registration/petla_beskidzka_2026___memorial_jana_ferdyna_dystans_giga_108_km/)
[ 21 czerwiec IX Bieg Wolności Kije 2026 ](https://www.pomiaryczasu.pl/event/ix_bieg_wolnosci_kije_2026/) [Zapisz się](https://www.pomiaryczasu.pl/registration/ix_bieg_wolnosci_kije_2026/)
# Zapisz się na "IX Bieg Wolności Kije 2026"
Bieg na dwóch dystansach: 10 km oraz 5,5 km."""


def test_strips_foreign_sibling_lines_keeps_self_and_content():
    self_urls = ["https://www.pomiaryczasu.pl/registration/ix_bieg_wolnosci_kije_2026/"]
    out = strip_foreign_event_lines(PCZ_PAGE, self_urls)
    # Pętla (foreign) lines and their distances are gone
    assert "Pętla" not in out
    assert "54 km" not in out
    assert "108 km" not in out
    # The event's own sidebar line and its real content survive
    assert "IX Bieg Wolności Kije 2026" in out
    assert "10 km oraz 5,5 km" in out


def test_no_self_slug_leaves_text_untouched():
    # External organizer site (different host, no event-prefix slug) → no stripping
    text = "[ Other Race ](https://www.pomiaryczasu.pl/event/other_race/) info"
    assert strip_foreign_event_lines(text, ["https://kasztelania.kije.pl/some-page/"]) == text


def test_empty_inputs():
    assert strip_foreign_event_lines("", ["https://x.pl/event/a/"]) == ""
    assert strip_foreign_event_lines("text", []) == "text"


def test_distinctive_tokens_drops_generic_and_editions():
    toks = _distinctive_tokens("VII Ochabski Bieg i Marsz NW Kobiet")
    assert "ochabski" in toks
    assert "bieg" not in toks       # generic
    assert "marsz" not in toks      # generic
    assert "kobiet" not in toks     # generic
    assert "vii" not in toks        # roman edition


def test_page_matches_event_rejects_wrong_event():
    event = {"name": "VII Ochabski Bieg i Marsz NW Kobiet"}
    runda_zubra_page = "Runda Żubra 2026 — regulamin biegu na 21,1 km w Białowieży."
    assert page_matches_event(event, runda_zubra_page) is False


def test_page_matches_event_accepts_right_event():
    event = {"name": "VII Ochabski Bieg i Marsz NW Kobiet"}
    page = "Regulamin VII Ochabski Bieg i Marsz NW Kobiet, Ochaby, dystans 5 km."
    assert page_matches_event(event, page) is True


def test_page_matches_event_generic_name_not_blocked():
    # No distinctive tokens → can't judge → don't block
    event = {"name": "Bieg Uliczny"}
    assert page_matches_event(event, "completely unrelated content") is True


def test_page_matches_event_empty_text_is_false():
    assert page_matches_event({"name": "Ochabski Bieg"}, "") is False


def test_distance_sanitizer_drops_junk_keeps_real():
    from enricher.steps.merge import _is_distance_like, _merge_distances
    assert _is_distance_like("unknown") is False
    assert _is_distance_like("brak") is False
    assert _is_distance_like("5 km") is True
    assert _is_distance_like("półmaraton") is True
    # An LLM "unknown" must not land as a distance value
    upd = {}
    _merge_distances({"distances": ""}, {"distances": ["unknown"]}, upd)
    assert "distances" not in upd
    # Real distances still fill an empty field
    upd2 = {}
    _merge_distances({"distances": ""}, {"distances": ["10 km", "5 km"]}, upd2)
    assert upd2["distances"] == "10 km, 5 km"
