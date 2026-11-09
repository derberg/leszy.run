"""protimer.pl: the regulamin PDF sits in an iframe on /rule, never in an <a>.

IX Myślenicki Bieg Niepodległości (maratonypolskie:91194) published with no
distances, regulamin_url, registration_deadline or price_from. Its
registration_url is protimer's /register form. The links below are what that
page carries (2026-11-09). /rule holds only
<iframe src="/bio/resources/rules/1481.pdf">, so the PDF was never a candidate.
"""
from enricher.steps.navigate import is_stub_host, pick_followup_urls

BASE = "https://protimer.pl/bio/1481/ix-myslenicki-bieg-niepodleglosci-11112026"
REGISTER = f"{BASE}/register"

REGISTER_LINKS = [
    {"href": "https://protimer.pl/", "text": ""},
    {"href": f"{BASE}/page", "text": "Informacje"},
    {"href": f"{BASE}/register", "text": "Zapisz się"},
    {"href": f"{BASE}/results", "text": "Wyniki"},
    {"href": f"{BASE}/participants", "text": "Lista uczestników"},
    {"href": f"{BASE}/rule", "text": "Regulamin"},
    {"href": f"{BASE}/login", "text": "Zaloguj się"},
    {"href": "https://protimer.pl/bio/user/register", "text": "Zarejestruj się tutaj"},
    {"href": f"{BASE}/document/51fb4c194a36e5e95c53e40fc9e127a8", "text": "MAPKA TRASY"},
]


def test_protimer_is_a_stub_host():
    assert is_stub_host(REGISTER) is True


def test_protimer_register_page_yields_the_rules_pdf_first():
    picked = pick_followup_urls(REGISTER, REGISTER_LINKS, [], max_internal=4, max_external=1)
    pdfs = [u for u in picked if u.lower().endswith(".pdf")]
    assert pdfs[:1] == ["https://protimer.pl/bio/resources/rules/1481.pdf"]


def test_protimer_register_page_follows_the_information_page():
    picked = pick_followup_urls(REGISTER, REGISTER_LINKS, [], max_internal=4, max_external=1)
    assert f"{BASE}/page" in picked


def test_protimer_rule_derived_even_without_links():
    picked = pick_followup_urls(REGISTER, [], [], max_internal=4, max_external=1)
    assert "https://protimer.pl/bio/resources/rules/1481.pdf" in picked
    assert f"{BASE}/page" in picked


def test_other_protimer_paths_get_no_rules_pdf():
    picked = pick_followup_urls("https://protimer.pl/", REGISTER_LINKS, [], max_internal=4)
    assert not any("/bio/resources/rules/" in u for u in picked)
