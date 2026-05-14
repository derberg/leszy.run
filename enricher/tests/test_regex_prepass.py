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