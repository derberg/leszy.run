import pytest
from enricher.steps.navigate import pdf_belongs_to_event
from enricher.steps.merge import _merge_scalars

# Measured 2026-09-14. All 11 elektronicznezapisy events whose own regulamin was a
# dead 30-byte error page fell through to the discovered-PDF fallback, which crawled
# up to the PLATFORM's own documents and extracted event fields from them:
# regulamin_portalu_internetowego_elektronicznezapisy_pl.pdf and
# polityka-prywatnosci.pdf. Four rows were rewritten from a privacy policy.
PRIVACY_POLICY = """
POLITYKA PRYWATNOSCI SERWISU ELEKTRONICZNEZAPISY.PL
Administratorem danych osobowych Uzytkownika jest Operator Serwisu.
Dane sa przetwarzane w celu swiadczenia uslug droga elektroniczna.
Uzytkownik ma prawo dostepu do swoich danych, ich sprostowania i usuniecia.
Serwis wykorzystuje pliki cookies.
"""

RACE_REGULAMIN = """
REGULAMIN XII ELBLASKI BIEG NIEPODLEGLOSCI
Termin: 11 listopada 2026, Elblag. Dystans 10 km.
Zapisy elektroniczne do dnia 01.11.2026. Oplata startowa 50 zl.
"""


def test_a_platform_privacy_policy_is_not_this_event_document():
    event = {"name": "XII Elblaski Bieg Niepodleglosci", "date": "2026-11-11"}
    assert pdf_belongs_to_event(event, PRIVACY_POLICY) is False


def test_the_races_own_regulamin_is_accepted():
    event = {"name": "XII Elblaski Bieg Niepodleglosci", "date": "2026-11-11"}
    assert pdf_belongs_to_event(event, RACE_REGULAMIN) is True


def test_empty_text_is_not_a_document():
    assert pdf_belongs_to_event({"name": "X", "date": "2026-01-01"}, "") is False


# XIV Biegi Przyjazni (2026-10-11) carried registration_deadline 2025-10-12 — the
# PREVIOUS edition's deadline, 364 days before the race. The rule was
# abs((event - deadline).days) > 365, so it passed. The same abs() also admitted a
# deadline LATER than the race, which cannot happen.
def _deadline_survives(event_date, deadline):
    updates = {}
    _merge_scalars({"name": "Bieg", "date": event_date}, {"registration_deadline": deadline}, updates, None)
    return "registration_deadline" in updates


def test_a_deadline_from_the_previous_edition_is_rejected():
    assert _deadline_survives("2026-10-11", "2025-10-12") is False


def test_a_deadline_after_the_race_is_rejected():
    assert _deadline_survives("2026-10-11", "2026-10-12") is False


def test_a_normal_deadline_is_kept():
    assert _deadline_survives("2026-10-11", "2026-10-04") is True


def test_a_deadline_on_race_day_is_kept():
    assert _deadline_survives("2026-10-11", "2026-10-11") is True


def test_an_early_bird_deadline_eight_months_out_is_kept():
    assert _deadline_survives("2027-06-25", "2026-11-01") is True
