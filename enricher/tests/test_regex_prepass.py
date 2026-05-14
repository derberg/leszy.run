from enricher.steps.regex_prepass import extract_hints


def test_extract_deadline_from_zapisy_internetowe_range_phrase():
    text = (
        "Zapisy internetowe na zawody RYKOwisko ULTRA-Trail trwały będą od "
        "15 stycznia 2026 godz. 20:00 do 19 maja 2026 godz. 23:59 lub "
        "zamknięcia list startowych."
    )

    hints = extract_hints([text], event_date="2026-05-23")

    assert hints["registration_deadline"] == "2026-05-19"


def test_extract_deadline_from_do_dnia_dotted_phrase():
    text = (
        "Zgłoszenia przyjmowane będą poprzez formularz zgłoszeniowy dostępny na stronie\n"
        "zapisy.inessport.pl do dnia 08.06.2026 r. do godz. 23:59"
    )

    hints = extract_hints([text], event_date="2026-06-14")

    assert hints["registration_deadline"] == "2026-06-08"


def test_extract_deadline_from_do_dn_abbreviated_phrase():
    text = (
        "prawidłowa rejestracja do dn. 15 lipca 2026 /środa/ do godz. 23:59 "
        "UWAGA: decyduje kolejność zgłoszeń wraz z uiszczeniem opłaty startowej"
    )

    hints = extract_hints([text], event_date="2026-07-19")

    assert hints["registration_deadline"] == "2026-07-15"


def test_extract_deadline_year_inferred_from_event_text_form():
    text = "zapisy do 15 maja"

    hints = extract_hints([text], event_date="2026-07-19")

    assert hints["registration_deadline"] == "2026-05-15"


def test_extract_deadline_year_inferred_rolls_back_when_month_past_event():
    # Event is in March 2026; deadline says "lipiec" (July) — must roll back to 2025
    text = "zapisy do 20 lipca"

    hints = extract_hints([text], event_date="2026-03-15")

    assert hints["registration_deadline"] == "2025-07-20"


def test_extract_deadline_year_inferred_dotted_noyear():
    text = "zapisy do 15.05."

    hints = extract_hints([text], event_date="2026-07-19")

    assert hints["registration_deadline"] == "2026-05-15"


def test_extract_deadline_tiered_przelew_list_picks_last_online_tier():
    text = (
        "wpłacenie opłaty startowej:\n"
        "• w wysokości 59 zł - przelew – do 24 maja 2026\n"
        "• w wysokości 69 zł - przelew – do 14 czerwca 2026\n"
        "• w wysokości 79 zł - przelew – do 25 czerwca 2026\n"
        "• w wysokości 100 zł – 28 czerwca 2026 w biurze zawodów (ograniczona ilość miejsc)"
    )

    hints = extract_hints([text], event_date="2026-06-29")

    assert hints["registration_deadline"] == "2026-06-25"


def test_extract_deadline_biuro_zawodow_dotted_excluded():
    # dotted form: "do" prefix is optional in the regex, so biurze zawodów check is essential
    text = (
        "przelew – do 25.06.2026\n"
        "• 28.06.2026 w biurze zawodów"
    )

    hints = extract_hints([text], event_date="2026-06-29")

    assert hints["registration_deadline"] == "2026-06-25"