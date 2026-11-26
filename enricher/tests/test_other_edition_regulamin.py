"""Another edition's regulamin must not enrich this edition.

XVIII Bieg Uliczny o Łaziskie Liście (maratonypolskie 91500, 2027-05-23) had no
regulamin. The 2026-11-26 run found the MOSiR page of the XVII edition, and the
verify gate rejected that page as the wrong edition. A PDF linked from it,
Regulamin-XVII-Biegu-Ulicznego-24.05.2026-r.pdf, still passed
pdf_belongs_to_event, because the race's name is the same every year. The LLM
read 60 zł, the distances and the nordic walking from the 2026 rules and wrote
them onto the 2027 row, while the PDF's URL went nowhere.
"""

import pytest

from enricher.steps.navigate import names_another_edition, pdf_belongs_to_event
from enricher.steps.validate_urls import UrlStatus

from tests.test_sibling_race_regulamin import _process, _run

LAZISKA = {"name": "XVIII Bieg Uliczny o Łaziskie Liście", "date": "2027-05-23", "location": "Łaziska Górne"}

# The first lines of the real PDF (pdftotext -layout, 2026-11-26), plus its fee.
XVII_PDF = (
    "REGULAMIN\n"
    "XVII Biegu Ulicznego o Łaziskie Liście im. Alojzego Kalei\n"
    "DYSTANS – 5 km, 10 km, NW 5 km\n"
    "Łaziska Górne, 24.05.2026 r.\n"
    "1. CEL IMPREZY\n"
    "3. TERMIN– 24 maja 2026 r.\n"
    "Zgłoszenia do 18.05.2026, opłata startowa 60 zł do 19.05.2026 r.\n"
)


def test_previous_edition_number_is_rejected():
    assert names_another_edition(LAZISKA, XVII_PDF) is True
    assert pdf_belongs_to_event(LAZISKA, XVII_PDF) is False


def test_previous_year_dates_reject_a_document_without_an_edition_number():
    event = {"name": "Bieg Uliczny o Łaziskie Liście", "date": "2027-05-23"}
    doc = "REGULAMIN\nBiegu Ulicznego o Łaziskie Liście\nTermin: 24.05.2026 r.\nZgłoszenia do 18.05.2026\n"
    assert names_another_edition(event, doc) is True


def test_this_edition_is_kept():
    doc = XVII_PDF.replace("XVII ", "XVIII ").replace("2026", "2027")
    assert names_another_edition(LAZISKA, doc) is False
    assert pdf_belongs_to_event(LAZISKA, doc) is True


def test_a_deadline_in_the_previous_year_does_not_reject_this_edition():
    # A January race closes its registration in December of the year before.
    event = {"name": "Zimowy Bieg Mikołajów", "date": "2027-01-16"}
    doc = "Regulamin Zimowego Biegu Mikołajów\nStart 16.01.2027\nZgłoszenia do 31.12.2026, wpłaty do 30.12.2026\n"
    assert names_another_edition(event, doc) is False


def test_law_dates_do_not_make_a_document_another_edition():
    event = {"name": "Bieg Uliczny o Łaziskie Liście", "date": "2027-05-23"}
    doc = (
        "REGULAMIN Biegu Ulicznego o Łaziskie Liście\n"
        "Dane przetwarzane zgodnie z ustawą z dnia 10 maja 2018 r. oraz Rozporządzeniem 2016/679.\n"
    )
    assert names_another_edition(event, doc) is False


def test_an_undated_document_is_not_judged():
    event = {"name": "Bieg Uliczny o Łaziskie Liście", "date": "2027-05-23"}
    assert names_another_edition(event, "REGULAMIN Biegu Ulicznego o Łaziskie Liście\nDystans 10 km\n") is False


def test_a_different_numeral_below_the_title_does_not_reject():
    # "XVII edycja" in a results history further down says nothing about this document.
    doc = (
        "REGULAMIN XVIII Biegu Ulicznego o Łaziskie Liście\nTermin 23.05.2027\n"
        + "Organizator: MOSiR.\n" * 10 + "Zwycięzcy XVII Biegu Ulicznego: …\n"
    )
    assert names_another_edition(LAZISKA, doc) is False


REGISTRATION_URL = "https://mosir.laziska.pl/wydarzenia/xvii-bieg-uliczny-o-laziskie-liscie/"
PDF_URL = "https://mosir.laziska.pl/wp-content/uploads/2026/03/Regulamin-XVII-Biegu-Ulicznego-24.05.2026-r.pdf"


@pytest.mark.asyncio
async def test_previous_edition_pdf_does_not_reach_extraction(sample_event):
    sample_event.update(LAZISKA)
    sample_event["registration_url"] = REGISTRATION_URL
    sample_event["regulamin_url"] = None
    sample_event["distances"] = None
    statuses = {"registration_url": UrlStatus(url=REGISTRATION_URL, status="alive", kind="html")}
    pages = {REGISTRATION_URL: "# XVII Bieg Uliczny o Łaziskie Liście"}

    result, m = await _process(
        sample_event, *_run(sample_event, statuses, pages, {REGISTRATION_URL: [PDF_URL]}, pdf_text=XVII_PDF)
    )

    assert result["steps"]["pdf_rejected"] == [PDF_URL]
    assert m["build_prompt"].call_args[0][2] is None, "the 2026 rules reached the prompt"
    assert "regulamin_url" not in result["updates"]
