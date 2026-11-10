"""2026-11-09: a verified race homepage was thrown away, and plus-timing forms
behind a bot challenge were rejected. See verify.py and merge.py."""
from types import SimpleNamespace

from enricher.steps.merge import _merge_website, _merge_urls
from enricher.steps.verify import is_plus_timing_form_for_event_year, verify_search_candidate

CFG = SimpleNamespace(aggregator_domains=["maratonypolskie.pl"], max_page_chars=6000)
EV = {"name": "XIII Zimowy Ultramaraton Karkonoski", "date": "2027-02-27"}
CHALLENGE = "Please wait while your request is being verified..."


def test_plus_timing_form_with_event_year():
    assert is_plus_timing_form_for_event_year("https://plus-timing.pl/zgloszenia/zuk-2027/", EV)
    assert is_plus_timing_form_for_event_year("https://www.plus-timing.pl/zgloszenia/zuk-2027", EV)


def test_plus_timing_other_year_or_path_or_host():
    assert not is_plus_timing_form_for_event_year("https://plus-timing.pl/zgloszenia/zuk-2026/", EV)
    assert not is_plus_timing_form_for_event_year("https://plus-timing.pl/wyniki/zuk-2027/", EV)
    assert not is_plus_timing_form_for_event_year("https://plus-timing.pl/zgloszenia/", EV)
    assert not is_plus_timing_form_for_event_year("https://evil.pl/zgloszenia/zuk-2027/", EV)
    assert not is_plus_timing_form_for_event_year("https://plus-timing.pl/zgloszenia/zuk-20271/", EV)


def test_verify_accepts_challenge_page_for_plus_timing_form():
    r = verify_search_candidate(EV, "registration_url", "https://plus-timing.pl/zgloszenia/zuk-2027/", CHALLENGE, CFG)
    assert r.ok and r.verdict == "match" and not r.llm_called


def test_verify_still_rejects_wrong_year_plus_timing_form():
    r = verify_search_candidate(EV, "registration_url", "https://plus-timing.pl/zgloszenia/zuk-2026/", CHALLENGE, CFG)
    assert not r.ok


def test_merge_writes_plus_timing_form_without_fetching(monkeypatch):
    import enricher.steps.merge as m
    monkeypatch.setattr(m, "verify_url_relevance", lambda *a: False)  # what the challenge page gives
    updates = {}
    _merge_urls(dict(EV), {}, {}, {"registration_url": "https://plus-timing.pl/zgloszenia/zuk-2027/"}, updates, EV["name"])
    assert updates["registration_url"] == "https://plus-timing.pl/zgloszenia/zuk-2027/"


def test_verified_homepage_becomes_website():
    updates = {}
    _merge_website(dict(EV), {"registration_url": "https://ultramaratonkarkonoski.pl/"}, updates, CFG)
    assert updates == {"website": "https://ultramaratonkarkonoski.pl/"}


def test_homepage_never_replaces_existing_website():
    updates = {}
    _merge_website({**EV, "website": "https://typed.by.admin.pl/"}, {"registration_url": "https://ultramaratonkarkonoski.pl/"}, updates, CFG)
    assert updates == {}


def test_platform_or_aggregator_root_is_not_a_website():
    for root in ("https://dostartu.pl/", "https://www.plus-timing.pl/", "https://maratonypolskie.pl/"):
        updates = {}
        _merge_website(dict(EV), {"registration_url": root}, updates, CFG)
        assert updates == {}, root


def test_page_with_path_is_not_a_website():
    updates = {}
    _merge_website(dict(EV), {"registration_url": "https://biegihopfera.pl/zapisy/"}, updates, CFG)
    assert updates == {}


def test_trusted_discovered_form_skips_the_name_fetch(monkeypatch):
    import enricher.steps.merge as m
    monkeypatch.setattr(m, "verify_url_relevance", lambda *a: False)  # a form shows a script shell
    updates = {}
    _merge_urls(dict(EV), {}, {}, {"registration_url": "https://forms.cloud.microsoft/e/abc"}, updates, EV["name"], frozenset({"registration_url"}))
    assert updates["registration_url"] == "https://forms.cloud.microsoft/e/abc"


def test_untrusted_form_still_needs_the_name_fetch(monkeypatch):
    import enricher.steps.merge as m
    monkeypatch.setattr(m, "verify_url_relevance", lambda *a: False)
    updates = {}
    _merge_urls(dict(EV), {}, {}, {"registration_url": "https://forms.cloud.microsoft/e/abc"}, updates, EV["name"])
    assert "registration_url" not in updates
