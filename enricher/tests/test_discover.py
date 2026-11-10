"""discover.py on the 2026-11-10 case: III Gminny Bieg Niepodległości, Cikowice.

Search returned news articles. One linked the Microsoft Forms sign-up and the
organizer's site root; the organizer's homepage linked its post ("czytaj
więcej", the race named only in the slug), which held the form and the
regulamin PDF. The fake pages below keep exactly those links plus the footer
junk that made the first version pick a portal's own regulamin.
"""
from enricher.steps.discover import (
    discover_from_pages, is_registration_link, is_regulamin_link, page_is_about_event,
)

EV = {"name": "III Gminny Bieg Niepodległości", "date": "2026-11-10", "location": "Cikowice"}
FORM = "https://forms.cloud.microsoft/e/myH07JAbYT"
POST = "https://gck.bochnia.pl/n,iii-gminny-bieg-niepodleglosci-oraz-nordic-walking-w-cikowicach-ruszaja-zapisy"
PDF = "https://gck.bochnia.pl/pliki/plik/regulamin-iii-gminnego-biegu-niepodleglosci-1791541249.pdf"

PAGES = {
    "https://news.pl/artykul-cikowice": (
        "<p>III Gminny Bieg Niepodległości w Cikowicach, 10 listopada 2026.</p>"
        f'<a href="{FORM}">{FORM}</a> <a href="http://gck.bochnia.pl">gck.bochnia.pl</a>'
        '<a href="/regulamin-serwisu">Regulamin serwisu</a>'
        '<a href="/artykul/zapisy-na-polkolonie">Zapisy na półkolonie</a>'
        '<a href="https://fundusze.example.pl/?utm_source=x">baner</a>'
    ),
    "http://gck.bochnia.pl": (
        "<p>Aktualności. III Gminny Bieg Niepodległości w Cikowicach 2026.</p>"
        f'<a href="/n,iii-gminny-bieg-niepodleglosci-oraz-nordic-walking-w-cikowicach-ruszaja-zapisy">czytaj więcej</a>'
        '<a href="/n,protokol-z-konkursu-ofert">czytaj więcej</a>'
    ),
    POST: (
        "<h1>III Gminny Bieg Niepodległości oraz Nordic Walking w Cikowicach – ruszają zapisy</h1>"
        "<p>10 listopada 2026</p>"
        f'<a href="{FORM}">III GMINNY BIEG NIEPODLEGŁOŚCI I NORDIC WALKING</a>'
        '<a href="/pliki/plik/regulamin-iii-gminnego-biegu-niepodleglosci-1791541249.pdf">Regulamin oraz zgoda rodzica</a>'
        '<a href="/pliki/plik/klauzule-zgody-do-formularzy.pdf">Zgoda na przetwarzanie danych osobowych</a>'
    ),
}


_BY_PATH = {k.split("://", 1)[1].rstrip("/"): (k, v) for k, v in PAGES.items()}


def fake_fetch(url):
    """http and https reach the same page, as a real redirect does."""
    hit = _BY_PATH.get(url.split("://", 1)[1].rstrip("/"))
    return hit if hit else None


def test_follows_article_to_organizer_post():
    out = discover_from_pages(EV, ["https://news.pl/artykul-cikowice"], fetch=fake_fetch)
    assert out["registration_url"] == FORM
    assert out["regulamin_url"] == PDF
    assert out["website"] == POST


def test_page_must_name_the_year_and_town():
    assert page_is_about_event(EV, "III Gminny Bieg Niepodległości w Cikowicach 2026")
    assert not page_is_about_event(EV, "III Gminny Bieg Niepodległości w Cikowicach 2025")
    assert not page_is_about_event(EV, "III Gminny Bieg Niepodległości w Bochni 2026")


def test_footer_links_are_not_candidates():
    assert not is_regulamin_link("https://portal.pl/regulamin-serwisu", "Regulamin serwisu", EV)
    assert not is_regulamin_link("https://um.warszawa.pl/regulamin-parkingu", "Regulamin", EV)
    assert not is_registration_link("https://portal.pl/artykul/zapisy-na-polkolonie", "Zapisy na półkolonie", EV)
    assert not is_registration_link("https://time-sport.pl/results/wyniki-x/", "wyniki", EV)


def test_platform_link_must_name_the_race():
    assert is_registration_link("https://b4sportonline.pl/bialolecka_triada_biegowa/bieg_wolnosci", "", {"name": "Białołęcki Bieg Wolności"})
    assert not is_registration_link("https://dostartu.pl/inny-bieg-v123", "zapisy", EV)


def test_consent_form_is_not_the_regulamin():
    assert not is_regulamin_link("https://gck.bochnia.pl/pliki/klauzule-zgody.pdf", "Zgoda na przetwarzanie", EV)
    assert is_regulamin_link(PDF, "Regulamin oraz zgoda rodzica", EV)


def test_nothing_about_the_event_gives_nothing():
    pages = {"https://x.pl/a": '<p>Inny bieg 2026</p><a href="https://forms.gle/abc">https://forms.gle/abc</a>'}
    out = discover_from_pages(EV, ["https://x.pl/a"], fetch=lambda u: (u, pages[u]) if u in pages else None)
    assert out["registration_url"] is None and out["regulamin_url"] is None and out["website"] is None
