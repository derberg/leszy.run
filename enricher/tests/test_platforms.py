from unittest.mock import patch

import pytest

from enricher.config import Config
from enricher.steps.merge import build_updates
from enricher.steps.platforms import is_platform_root_url

config = Config()


# VII Bieg Pocztyliona, 2026-09-20, Cewice. The enricher stored
# https://zapisy.info/ here. That page lists every upcoming race on the
# platform, this one included, so verify_url_relevance found the event name on
# it and let it through. The race's own page is
# https://zapisy.info/imprezy/718/ and it is the one carrying the registration
# window.
POCZTYLION = {
    "id": "b0f1bb90-2251-454c-8c7d-d8c29876fc88",
    "name": "VII Bieg Pocztyliona",
    "date": "2026-09-20",
    "location": "Cewice",
    "voivodeship": "Pomorskie",
    "registration_url": None,
    "regulamin_url": "http://www.kaszubybiegaja.pl/28-regulamin",
    "registration_deadline": None,
}


@pytest.mark.parametrize("url", [
    "https://zapisy.info/",
    "https://zapisy.info",
    "http://www.zmierzymyczas.pl",
    "https://dostartu.pl/",
    "https://elektronicznezapisy.pl",
    # Share links: the tracking parameter changes nothing about what the URL
    # points at.
    "https://superczas.pl/?fbclid=IwY2xjawTZy1lw",
    "https://zapisy.inessport.pl/?fbclid=IwY2xjawQkCLp",
])
def test_platform_roots(url):
    assert is_platform_root_url(url) is True


@pytest.mark.parametrize("url", [
    # The platform's own event pages.
    "https://zapisy.info/imprezy/718/",
    "https://dostartu.pl/permalink-v12345",
    "https://zapisy.inessport.pl/#gr291",
    "https://online.datasport.pl/zapisy/portal/zawody.php?zawody=51",
    # Organizer domains: an empty path there is the whole address.
    "https://naszadycha.pl",
    "https://cracoviapolmaraton.pl",
    # A race given its own subdomain on a platform — the subdomain IS the event.
    "https://5.biegnijmy.pl",
    # Junk.
    "",
    None,
    "zapisy.info",
])
def test_not_platform_roots(url):
    assert is_platform_root_url(url) is False


def test_platform_homepage_is_not_written_as_registration_url():
    """The exact path that produced the VII Bieg Pocztyliona row."""
    llm = {"registration_url": "https://zapisy.info/", "url_is_registration": True}
    with patch("enricher.steps.merge.verify_url_relevance", return_value=True):
        updates = build_updates(POCZTYLION, llm, {}, {}, config, had_content=True)
    assert "registration_url" not in updates


def test_platform_event_page_is_written_as_registration_url():
    llm = {"registration_url": "https://zapisy.info/imprezy/718/", "url_is_registration": True}
    with patch("enricher.steps.merge.verify_url_relevance", return_value=True):
        updates = build_updates(POCZTYLION, llm, {}, {}, config, had_content=True)
    assert updates["registration_url"] == "https://zapisy.info/imprezy/718/"


def test_regulamin_url_is_untouched_by_the_rule():
    """Only registration_url is gated — a rules document is a different question."""
    event = dict(POCZTYLION, regulamin_url=None)
    llm = {"regulamin_url": "https://zapisy.info/", "url_is_regulamin": True}
    with patch("enricher.steps.merge.verify_url_relevance", return_value=True):
        updates = build_updates(event, llm, {}, {}, config, had_content=True)
    assert updates["regulamin_url"] == "https://zapisy.info/"
