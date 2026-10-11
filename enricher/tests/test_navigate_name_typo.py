"""A typo in the scraped event name must not reject the event's own regulamin.

raatiming lists "Bieg Legionsty"; the organiser's PDF is "Regulamin XXXIII Biegu
Legionisty". The only distinctive token, "legionsty", is one letter short of
"legionisty", so the exact substring test rejected the PDF and the row published
with no distances and no registration_deadline.
"""
from enricher.steps.navigate import page_matches_event, pdf_belongs_to_event

LEGIONISTY_PDF = (
    "Regulamin XXXIII Biegu Legionisty\n"
    "§4 Program zawodów: 600 m, 800 m, 1000 m, 1500 m.\n"
    "§5 pkt 10. Ostateczna rejestracja do dnia 16 października 2026 r.\n"
)


def test_one_letter_typo_in_name_still_matches_pdf():
    event = {"name": "Bieg Legionsty", "date": "2026-10-23"}
    assert pdf_belongs_to_event(event, LEGIONISTY_PDF) is True


def test_typo_tolerance_does_not_accept_a_different_name():
    event = {"name": "Bieg Legionsty", "date": "2026-10-23"}
    assert page_matches_event(event, "Regulamin Biegu Niepodległości, 5 km") is False


def test_short_tokens_still_need_an_exact_match():
    # 4-5 letter tokens are too short for one edit to mean a typo.
    assert page_matches_event({"name": "Bieg Rysia"}, "Bieg Lisia 5 km") is False


def test_one_substituted_letter_is_a_different_name():
    # "gdyński" and "gdański" are one substitution apart and are different towns.
    event = {"name": "Półmaraton Gdyński", "date": "2026-10-23"}
    text = "Regulamin Półmaratonu Gdańskiego. Organizator: Gdański Ośrodek Sportu."
    assert pdf_belongs_to_event(event, text) is False


def test_search_and_verify_gate_stays_exact():
    # The typo allowance is for the PDF gate only; page_matches_event, which
    # also gates search hits and verify.py, still needs the exact token.
    event = {"name": "Bieg Legionsty", "date": "2026-10-23"}
    assert page_matches_event(event, LEGIONISTY_PDF) is False
