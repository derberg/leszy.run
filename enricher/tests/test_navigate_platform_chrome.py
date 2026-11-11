"""A registration platform's own pages are not the event's.

Every elektronicznezapisy event page carries the site's navigation, and its
"Cennik" link (pricelist.html, anchor score 9) is the platform's price list FOR
ORGANIZERS: "1,50 zł brutto od zapisanego i opłaconego zawodnika", "123 zł
uruchomienie pierwszej imprezy", "opłata minimalna wynosi 80 zł". Following it
from a placeholder event with an empty Cennik is where the 1-123 price range of
ten scraper_all rows came from (Goń Zajączka III Bieg Charytatywny, 15282,
among them). Links sampled from the live signup page on 2026-11-11.
"""
from enricher.steps.navigate import pick_followup_urls

BASE = "https://elektronicznezapisy.pl/event/15282/signup.html"


def _abs(path):
    # The page sets <base href="https://elektronicznezapisy.pl/">; the crawler
    # hands over absolute links.
    return "https://elektronicznezapisy.pl/" + path

CHROME = [
    {"href": _abs("pricelist.html"), "text": "Cennik"},
    {"href": _abs("news.html"), "text": "Aktualności"},
    {"href": _abs("events.html"), "text": "Imprezy"},
    {"href": _abs("registration.html"), "text": "Załóż konto"},
    {"href": _abs("about-us.html"), "text": "O nas"},
]

OWN = [
    {"href": _abs("event/15282.html"), "text": "Opis imprezy"},
    {"href": _abs("event/15282/clients.html"), "text": "Lista uczestników"},
]


def test_the_platform_price_list_is_never_followed_from_an_event_page():
    picked = pick_followup_urls(BASE, CHROME + OWN, [], max_internal=4, max_external=1)
    assert _abs("pricelist.html") not in picked
    assert _abs("registration.html") not in picked


def test_the_event_own_description_page_is_followed():
    picked = pick_followup_urls(BASE, CHROME + OWN, [], max_internal=4, max_external=1)
    assert _abs("event/15282.html") in picked


def test_another_event_is_still_foreign():
    links = [{"href": _abs("event/15283.html"), "text": "Opis imprezy"}]
    assert pick_followup_urls(BASE, links, [], max_internal=4, max_external=1) == []


def test_an_organizer_site_keeps_its_cennik_link():
    # Off a platform the rule does not apply: an organizer's own "Cennik" page is
    # the event's fee table.
    links = [{"href": "/cennik", "text": "Cennik"}]
    picked = pick_followup_urls("https://bieg.example.pl/zapisy/bieg-2026", links, [],
                                max_internal=3, max_external=0)
    assert "https://bieg.example.pl/cennik" in picked


def test_a_platform_pdf_without_an_event_slug_is_still_offered():
    # PDFs keep their own gate (pdf_belongs_to_event): an event regulamin is often
    # uploaded under a path with no event id.
    links = [{"href": _abs("upload/regulamin_bieg.pdf"), "text": "Regulamin"}]
    picked = pick_followup_urls(BASE, links, [], max_internal=4, max_external=1)
    assert _abs("upload/regulamin_bieg.pdf") in picked
