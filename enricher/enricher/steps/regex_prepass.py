"""Cheap regex-based extraction of obvious factual fields.

Runs before the LLM so:
  - We get concrete values for prices and dates even when the LLM hallucinates
  - We can decide to skip the LLM entirely when everything we'd ask is already
    known (no content, no extraction cost, no corruption risk)
  - The LLM gets regex hints in the prompt to anchor against

Returns a dict with the same keys used downstream:
  {price_from, price_to, registration_deadline}
Each value is None if not confidently extracted.
"""
from __future__ import annotations

import re
from datetime import date as _date

# Polish month names → month number (lowercase, no accents folded)
_MONTHS = {
    "stycznia": 1, "lutego": 2, "marca": 3, "kwietnia": 4, "maja": 5,
    "czerwca": 6, "lipca": 7, "sierpnia": 8, "września": 9, "wrzesnia": 9,
    "października": 10, "pazdziernika": 10, "listopada": 11, "grudnia": 12,
}

# Numbers immediately followed by zł/PLN/złot. Captures integer or decimal values.
# Accepts comma or dot as decimal separator, and optional spaces before the currency.
_PRICE_RE = re.compile(
    r"(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:zł|pln|złot)",
    re.IGNORECASE,
)

# Phrases that mean the event is free. Polish regulamins very rarely say "0 zł"
# explicitly — they use natural language like "bezpłatny" or "nie ma opłat".
# Anchored to entry-fee context (opłat wpisow / udział / start) to avoid false
# positives like "darmowa woda na trasie" or "bezpłatne miejsca parkingowe".
_FREE_EVENT_RE = re.compile(
    r"(?:"
    r"udział\s+(?:w\s+\w+\s+)?(?:jest\s+)?(?:darmow|bezpłatn|nieodpłatn)"
    r"|nie\s+(?:ma|pobier\w*|wnosi\s+się)\s+opłat"
    r"|brak\s+opłat\s+(?:start|wpisow)"
    r"|(?:opłata|wpisowe)\s+(?:start\w+\s+)?(?:wynosi\s+)?0\s*(?:zł|pln)?\s*(?:[.,]|$)"
    r"|wpisowe\s+nie\s+(?:obowiązuje|jest)"
    r"|wolny\s+od\s+opłat"
    r"|bez\s+opłat\w*\s+startow\w*"
    r")",
    re.IGNORECASE,
)

# Deadline: "do 15 maja 2026" / "do dnia 15 maja 2026" / "do 15.05.2026" /
# "do dnia 15.05.2026" / "do 2026-05-15" / "do godziny 23:59 w poniedziałek 8 czerwca 2026"
# Polish regulamins use a few common "do <stuff> <date>" patterns where the
# date isn't directly after "do":
#   - "do dnia <date>"                                 (most common)
#   - "do godziny HH:MM <date>"                        (zmierzymyczas-style — "do godziny 23:59 8 czerwca")
#   - "do godziny HH:MM w <day-name> <date>"           ("do godziny 23:59 w poniedziałek 8 czerwca")
_DO_DNIA = (
    r"do\s+"
    r"(?:dnia\s+"
    r"|dn\.\s+"
    r"|godziny\s+\d{1,2}[:.]\d{2}(?:\s+w\s+\w+)?\s+"
    r")?"
)
_DEADLINE_TEXT_RE = re.compile(
    rf"{_DO_DNIA}(\d{{1,2}})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze(?:ś|s)nia|pa(?:ź|z)dziernika|listopada|grudnia)\s+(\d{{4}})",
    re.IGNORECASE,
)
_DEADLINE_DOTTED_RE = re.compile(
    rf"(?:{_DO_DNIA})?(\d{{1,2}})\.(\d{{1,2}})\.(\d{{4}})",
    re.IGNORECASE,
)
_DEADLINE_ISO_RE = re.compile(rf"(?:{_DO_DNIA})?(\d{{4}})-(\d{{2}})-(\d{{2}})", re.IGNORECASE)

# Year-less variants — only used when event_date is supplied for year inference.
# Negative lookahead prevents shadowing the year-bearing patterns above.
_DEADLINE_TEXT_NOYEAR_RE = re.compile(
    rf"{_DO_DNIA}(\d{{1,2}})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze(?:ś|s)nia|pa(?:ź|z)dziernika|listopada|grudnia)(?!\s+\d{{4}})",
    re.IGNORECASE,
)
# Dotted year-less: "15.07." — trailing dot required, no 4-digit year following.
_DEADLINE_DOTTED_NOYEAR_RE = re.compile(
    rf"(?:{_DO_DNIA})?(\d{{1,2}})\.(\d{{1,2}})\.(?!\d)",
    re.IGNORECASE,
)

# Only look for deadlines near these anchor phrases (within ±200 chars).
# Several anchor variants below cover the same intent in different word orders
# — "Zapisy będą przyjmowane … do" vs "Zgłoszenia przyjmowane …", and
# "do godziny 23:59" cutoffs that don't say "do dnia" anywhere.
_DEADLINE_ANCHORS = [
    "termin zgłosz", "zapisy do", "zapisów do", "rejestracja do",
    "rejestracji do", "koniec zapisów", "zgłoszenia do", "zgloszenia do",
    "zgłoszenia przyjmow", "zgloszenia przyjmow",
    "zapisy internetowe", "zapisy online",
    "zapisy będą przyjmow", "zapisy beda przyjmow",
    "zapisy są przyjmow", "zapisy sa przyjmow",
    "zapisy trwają", "zapisy trwaja",
    "trwały będą", "trwaly beda",
    "zapisy przyjmow", "zapisy przyjm",
    "zamknięcie zapisów", "zamkniecie zapisow", "przyjmowanie zgłosz",
    "ostateczny termin", "termin zapisów", "termin zapisow",
    "opłata startowa", "wpłacona w terminie", "wplacona w terminie",
    "przelew",     # "przelew – do 25 czerwca 2026" — tiered price/deadline lists
    "do godziny",  # "Zgłoszenia ... do godziny 23:59 w poniedziałek 8 czerwca 2026"
    "do dnia",     # "DO DNIA 29.07.2026 R." — common standalone deadline marker
]

# Dates that appear near these phrases are NOT registration deadlines — they're
# day-of race-office options or similar. Applied as a local ±80 char check on
# each candidate match.
_DEADLINE_NEGATIVE_TOKENS = [
    "biurze zawodów", "biurze zawodow",  # "w biurze zawodów" — day-of race office
    "biuro zawodów", "biuro zawodow",
    "w dniu zawodów", "w dniu zawodow",
    "w dniu imprezy",
]


def extract_hints(
    texts: list[str], event_date: str | None = None
) -> dict:
    """Run regex pre-pass on a list of text blobs.

    Returns {price_from, price_to, registration_deadline} with each value set
    to a concrete Python value (int / str) only when confidently extracted,
    otherwise None.

    event_date: used to validate deadlines fall within 1 year before the event.
    """
    result = {
        "price_from": None,
        "price_to": None,
        "registration_deadline": None,
    }

    combined = "\n".join(t for t in texts if t)
    if not combined.strip():
        return result

    # --- Prices ---
    prices = _extract_prices(combined)
    if prices:
        result["price_from"] = min(prices)
        result["price_to"] = max(prices)
    elif _FREE_EVENT_RE.search(combined):
        # Free event: explicitly set both to 0 so downstream merge writes them
        # rather than treating them as "missing"
        result["price_from"] = 0
        result["price_to"] = 0

    # --- Deadline ---
    result["registration_deadline"] = _extract_deadline(combined, event_date)

    return result


# Only count `\d+ zł` matches that fall near entry-fee context. Without this,
# the regex grabs every "300 zł nagroda" / "limit 500 osób" / "koszt naprawy
# 1000 zł" / "wpłata charytatywna 1 zł" on the page and pollutes price_from /
# price_to (we saw real cases produce 0-500 and 1-123 ranges, both wrong).
_PRICE_ANCHORS = [
    "opłata startowa", "oplata startowa",
    "opłat startow", "oplat startow",
    "opłaty startowej", "oplaty startowej",
    "opłatę startową", "oplate startowa",
    "wysokość opłaty", "wysokosc oplaty",
    "wpisowe", "wpisowego",
    "koszt udziału", "koszt udzialu",
    "koszt startu", "koszt uczestnictwa",
    "koszt zapisu", "koszt biegu",
    "cena pakietu", "cena startu",
    # Polish regulamin-table headers
    "opłaty\n", "oplaty\n",
    "płatności\n", "platnosci\n",
    # Inline phrasings
    "wynosi:", "wynosi ",
    "wpłacona w terminie", "wplacona w terminie",
    "do biura zawodów",
    # superczas.pl-style and rajsportactive.pl-style phrasings missed earlier
    # ("Bieg na 5 km ... jest odpłatny: 50 zł płatne przelewem ...")
    "jest odpłatny", "jest odplatny",
    "płatne przelewem", "platne przelewem",
    "płatne online", "platne online",
    "przy wpłacie na konto",
    "pakiet startowy",
]

# Phrases whose nearby `\d+ zł` is NOT an entry fee — name-transfer fees,
# protest deposits, prize money caps, etc. If any of these tokens appear in
# the same ±50 char window as a candidate price, the price is dropped.
_PRICE_NEGATIVE_TOKENS = [
    "kaucj",            # kaucji 100 zł (protest deposit)
    "depozyt",          # depozyt nie może przekraczać 400 zł
    "depozytu",
    "przepisani",       # koszt przepisania 20 zł (name transfer)
    "zmiany danych",
    "skreśle",          # cancellation/refund context
    "zwrot",            # refund / return amount
    "nagrod",           # prize money (nagroda, nagrody)
    "puchar",           # cup/award value
    "limit",            # "limit 500 osób" — false positive on "500 zł"-style appearances
]


def _extract_prices(text: str) -> list[int]:
    """Extract entry-fee amounts that appear near entry-fee context anchors.

    Returns deduplicated int list. Plausibility-checked to 0..2000 PLN.
    """
    flat = text.lower()
    # Build search windows around each anchor
    windows: list[tuple[int, int]] = []
    for anchor in _PRICE_ANCHORS:
        start = 0
        while True:
            idx = flat.find(anchor, start)
            if idx < 0:
                break
            windows.append((max(0, idx - 30), min(len(text), idx + len(anchor) + 400)))
            start = idx + 1

    if not windows:
        return []

    # Collapse overlapping windows so the same `\d+ zł` doesn't get counted twice
    windows.sort()
    merged: list[tuple[int, int]] = []
    for s, e in windows:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))

    found = set()
    for s, e in merged:
        window = text[s:e]
        for m in _PRICE_RE.finditer(window):
            raw = m.group(1).replace(",", ".")
            try:
                val = float(raw)
            except ValueError:
                continue
            if not (0 <= val <= 2000):
                continue
            # Drop matches whose immediate ±50 char neighbourhood contains
            # negative-context tokens — kaucja, depozyt, koszt przepisania,
            # nagroda etc. — the number is not an entry fee.
            local_s = max(0, m.start() - 50)
            local_e = min(len(window), m.end() + 50)
            local = window[local_s:local_e].lower()
            if any(neg in local for neg in _PRICE_NEGATIVE_TOKENS):
                continue
            found.add(int(round(val)))
    return sorted(found)


def _near_deadline_negative(m, window: str, radius: int = 80) -> bool:
    local = window[max(0, m.start() - radius):min(len(window), m.end() + radius)]
    return any(neg in local for neg in _DEADLINE_NEGATIVE_TOKENS)


def _month_number(raw: str) -> int | None:
    month = _MONTHS.get(raw)
    if month is not None:
        return month
    norm = raw.replace("ś", "s").replace("ź", "z")
    for key, val in _MONTHS.items():
        if norm == key.replace("ś", "s").replace("ź", "z"):
            return val
    return None


def _infer_year(ev: _date, month: int, day: int) -> _date | None:
    """Return date(ev.year or ev.year-1, month, day), whichever falls before ev."""
    for delta in (0, -1):
        try:
            d = _date(ev.year + delta, month, day)
        except ValueError:
            continue
        if d < ev:
            return d
    return None


def _extract_deadline(text: str, event_date: str | None) -> str | None:
    """Extract a registration deadline from text near deadline-anchor phrases.

    Returns YYYY-MM-DD or None. Validates that the deadline is within 1 year
    before the event date if known.
    """
    flat = text.lower()

    ev = None
    if event_date:
        try:
            ev = _date.fromisoformat(event_date)
        except ValueError:
            pass

    # Find all anchor positions — only extract deadlines within ±200 chars of one
    anchor_ranges = []
    for anchor in _DEADLINE_ANCHORS:
        start = 0
        while True:
            idx = flat.find(anchor, start)
            if idx < 0:
                break
            anchor_ranges.append((max(0, idx - 50), min(len(text), idx + len(anchor) + 200)))
            start = idx + 1

    if not anchor_ranges:
        return None

    candidates = []
    for a_start, a_end in anchor_ranges:
        window = text[a_start:a_end]
        wlow = window.lower()

        # ISO
        for m in _DEADLINE_ISO_RE.finditer(wlow):
            if _near_deadline_negative(m, wlow):
                continue
            try:
                d = _date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                candidates.append(d)
            except ValueError:
                continue

        # Dotted
        for m in _DEADLINE_DOTTED_RE.finditer(wlow):
            if _near_deadline_negative(m, wlow):
                continue
            try:
                d = _date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
                candidates.append(d)
            except ValueError:
                continue

        # Text form ("do 15 maja 2026")
        for m in _DEADLINE_TEXT_RE.finditer(wlow):
            if _near_deadline_negative(m, wlow):
                continue
            month = _month_number(m.group(2).lower())
            try:
                d = _date(int(m.group(3)), month, int(m.group(1)))
                candidates.append(d)
            except (ValueError, TypeError):
                continue

        # Year-less forms — only when event year is known for inference
        if ev is not None:
            for m in _DEADLINE_TEXT_NOYEAR_RE.finditer(wlow):
                if _near_deadline_negative(m, wlow):
                    continue
                month = _month_number(m.group(2).lower())
                if month is None:
                    continue
                d = _infer_year(ev, month, int(m.group(1)))
                if d:
                    candidates.append(d)

            for m in _DEADLINE_DOTTED_NOYEAR_RE.finditer(wlow):
                if _near_deadline_negative(m, wlow):
                    continue
                try:
                    d = _infer_year(ev, int(m.group(2)), int(m.group(1)))
                    if d:
                        candidates.append(d)
                except (ValueError, TypeError):
                    continue

    if not candidates:
        return None

    # Validate against event date: deadline should be ≤ event date and ≥ event date - 1 year
    valid = []
    for d in candidates:
        if ev is not None:
            if d > ev:
                continue
            if d == ev:
                # The race day itself is never a registration deadline — it's
                # typically a reference to the event start time or biuro zawodów
                # hours. Including it causes false positives when "01.08.2026"
                # appears near a price/registration anchor.
                continue
            if (ev - d).days > 365:
                continue
        valid.append(d)

    if not valid:
        return None

    # Pick the LATEST valid deadline — regulamins often list multiple tiers,
    # and the final one is the actual cutoff.
    chosen = max(valid)
    return chosen.isoformat()
