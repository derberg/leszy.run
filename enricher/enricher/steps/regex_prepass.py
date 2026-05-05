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

# Deadline: "do 15 maja 2026" / "do dnia 15 maja 2026" / "do 15.05.2026" / "do dnia 15.05.2026" / "do 2026-05-15"
# Polish regulamins frequently say "do dnia <date>" — the older patterns missed those.
_DO_DNIA = r"do\s+(?:dnia\s+)?"  # "do " or "do dnia "
_DEADLINE_TEXT_RE = re.compile(
    rf"{_DO_DNIA}(\d{{1,2}})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze(?:ś|s)nia|pa(?:ź|z)dziernika|listopada|grudnia)\s+(\d{{4}})",
    re.IGNORECASE,
)
_DEADLINE_DOTTED_RE = re.compile(
    rf"(?:{_DO_DNIA})?(\d{{1,2}})\.(\d{{1,2}})\.(\d{{4}})",
    re.IGNORECASE,
)
_DEADLINE_ISO_RE = re.compile(rf"(?:{_DO_DNIA})?(\d{{4}})-(\d{{2}})-(\d{{2}})", re.IGNORECASE)

# Only look for deadlines near these anchor phrases (within ±200 chars).
# "Zgłoszenia przyjmowane" covers regulamins like "Zgłoszenia przyjmowane są ... do dnia 24.09.2026"
# which the more rigid "zgłoszenia do" anchor missed.
_DEADLINE_ANCHORS = [
    "termin zgłosz", "zapisy do", "zapisów do", "rejestracja do",
    "rejestracji do", "koniec zapisów", "zgłoszenia do", "zgloszenia do",
    "zgłoszenia przyjmow", "zgloszenia przyjmow",
    "zamknięcie zapisów", "zamkniecie zapisow", "przyjmowanie zgłosz",
    "ostateczny termin", "termin zapisów", "termin zapisow",
    "opłata startowa", "wpłacona w terminie", "wplacona w terminie",
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

    # --- Deadline ---
    result["registration_deadline"] = _extract_deadline(combined, event_date)

    return result


def _extract_prices(text: str) -> list[int]:
    """Extract all plausible entry-fee amounts. Returns deduplicated int list."""
    found = set()
    for m in _PRICE_RE.finditer(text):
        raw = m.group(1).replace(",", ".")
        try:
            val = float(raw)
        except ValueError:
            continue
        # Plausibility: Polish running entry fees realistically range 0–2000 PLN
        if 0 <= val <= 2000:
            found.add(int(round(val)))
    return sorted(found)


def _extract_deadline(text: str, event_date: str | None) -> str | None:
    """Extract a registration deadline from text near deadline-anchor phrases.

    Returns YYYY-MM-DD or None. Validates that the deadline is within 1 year
    before the event date if known.
    """
    flat = text.lower()

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
            try:
                d = _date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                candidates.append(d)
            except ValueError:
                continue

        # Dotted
        for m in _DEADLINE_DOTTED_RE.finditer(wlow):
            try:
                d = _date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
                candidates.append(d)
            except ValueError:
                continue

        # Text form ("do 15 maja 2026")
        for m in _DEADLINE_TEXT_RE.finditer(wlow):
            day = int(m.group(1))
            month_raw = m.group(2).lower()
            # Normalize accent-folded variants
            month = _MONTHS.get(month_raw)
            if month is None:
                for key, val in _MONTHS.items():
                    if month_raw.replace("ś", "s").replace("ź", "z") == key.replace("ś", "s").replace("ź", "z"):
                        month = val
                        break
            year = int(m.group(3))
            try:
                d = _date(year, month, day)
                candidates.append(d)
            except (ValueError, TypeError):
                continue

    if not candidates:
        return None

    # Validate against event date: deadline should be ≤ event date and ≥ event date - 1 year
    ev = None
    if event_date:
        try:
            ev = _date.fromisoformat(event_date)
        except ValueError:
            ev = None

    valid = []
    for d in candidates:
        if ev is not None:
            if d > ev:
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
