import httpx
import respx
from enricher.steps.search import search_missing_urls
from enricher.config import Config


# Grand Prix CITY TRAIL (maratonypolskie 90114, 2026-11-21; 90117, 2027-01-17)
# and Grand Prix Dziewiczej Góry (maratonypolskie 89673, 2027-01-16) published
# with no registration_url. The web search found nothing, yet regulamin_url
# already named the organizer's site, and its home page links to the sign-up.
config = Config()

NO_HITS = {"results": []}

CITYTRAIL_HOME = """
<html><body>
  <nav>
    <a href="https://citytrail.pl/aktualnosci">Aktualności</a>
    <a href="https://citytrail.pl/strony/stat/id/8/regulamin-bieg-glowny">Regulamin</a>
    <a href="https://citytrail.pl/zapisy" class="ct-menu__register"><span>ZAPISZ SIĘ!</span></a>
  </nav>
  <a href="https://www.facebook.com/citytrail/zapisy">Facebook</a>
</body></html>
"""

DZIEWICZA_HOME = """
<html><body>
  <ul class="menu">
    <li><a href="/regulamin-2026-2027/">REGULAMIN</a></li>
    <li><a href="https://dziewiczagorabiega.pl/formularz-zgloszen/">FORMULARZ ZGŁOSZEŃ</a></li>
  </ul>
</body></html>
"""


def test_registration_falls_back_to_the_sign_up_link_on_the_regulamin_host():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=NO_HITS)
        )
        respx.get("https://citytrail.pl/").mock(
            return_value=httpx.Response(200, text=CITYTRAIL_HOME)
        )
        result = search_missing_urls(
            event={
                "name": "Grand Prix CITY TRAIL",
                "date": "2026-11-21",
                "location": "Poznań",
                "regulamin_url": "https://citytrail.pl/strony/stat/id/8/regulamin-bieg-glowny",
            },
            missing_fields=["registration_url"],
            config=config,
        )
    assert result.get("registration_url") == "https://citytrail.pl/zapisy"


def test_registration_fallback_reads_a_form_link_by_its_anchor_text():
    with respx.mock:
        respx.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=NO_HITS)
        )
        respx.get("https://dziewiczagorabiega.pl/").mock(
            return_value=httpx.Response(200, text=DZIEWICZA_HOME)
        )
        result = search_missing_urls(
            event={
                "name": "Grand Prix Dziewiczej Góry w Biegach Gór...",
                "date": "2027-01-16",
                "location": "Czerwonak",
                "regulamin_url": "https://dziewiczagorabiega.pl/regulamin-2026-2027/",
            },
            missing_fields=["registration_url"],
            config=config,
        )
    assert result.get("registration_url") == "https://dziewiczagorabiega.pl/formularz-zgloszen/"


def test_registration_fallback_never_reads_an_aggregator_home_page():
    with respx.mock(assert_all_called=False) as mock:
        mock.get("http://localhost:8888/search").mock(
            return_value=httpx.Response(200, json=NO_HITS)
        )
        home = mock.get("https://datasport.pl/").mock(
            return_value=httpx.Response(200, text='<a href="/zapisy">Zapisy</a>')
        )
        result = search_missing_urls(
            event={
                "name": "Bieg Leszka",
                "date": "2026-05-10",
                "location": "Warszawa",
                "regulamin_url": "https://datasport.pl/regulamin/12743.pdf",
            },
            missing_fields=["registration_url"],
            config=config,
        )
    assert result.get("registration_url") is None
    assert not home.called
