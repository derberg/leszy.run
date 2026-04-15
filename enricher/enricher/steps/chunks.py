"""Extract focused chunks around keywords from text content.

Instead of sending 6k chars of raw text to the LLM, find the relevant
sections (prices, deadlines, distances) and send only those.
"""

import re

# Keyword groups — each group extracts text relevant to a specific field
KEYWORD_GROUPS = {
    "prices": {
        "keywords": [
            "opłata startowa", "opłaty", "wpisowe", "cennik", "pakiet startowy",
            "koszt uczestnictwa", "opłata za udział", "bezpłatny", "bezpłatne",
            "darmowy", "free", "cena",
        ],
        "patterns": [
            r"\d+[.,]?\d*\s*(?:zł|złot|PLN)",  # 99 zł, 99.00 zł, 50 PLN
            r"(?:zł|złot|PLN)\s*\d+",            # zł 99
        ],
    },
    "deadlines": {
        "keywords": [
            "termin zgłoszeń", "zapisy do", "rejestracja do", "limit zgłoszeń",
            "termin rejestracji", "koniec zapisów", "zapisy zamknięte",
            "ostateczny termin", "zgłoszenia przyjmowane", "zapisy trwają",
            "zamknięcie zapisów", "termin zapisów", "do dnia",
        ],
        "patterns": [
            # Polish text-form dates near deadline context, e.g. "do 15 maja 2026"
            r"do\s+\d{1,2}\s+(?:stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia)\s+\d{4}",
            # ISO dates
            r"\d{4}-\d{2}-\d{2}",
            # European dotted dates
            r"\d{1,2}\.\d{1,2}\.\d{4}",
        ],
    },
    "distances": {
        "keywords": [
            "dystans", "trasa", "długość trasy", "kategorie wiekowe",
        ],
        "patterns": [
            r"\d+[.,]?\d*\s*km",        # 5 km, 21.1 km
            r"półmaraton|maraton|ultra",
        ],
    },
}

# How many chars to grab around each keyword hit
WINDOW_BEFORE = 100
WINDOW_AFTER = 300


def extract_chunks(text: str, max_total_chars: int = 3000) -> dict[str, str]:
    """Extract focused text chunks around keywords.

    Returns {"prices": "...", "deadlines": "...", "distances": "..."} with
    only the relevant sections from the text. Empty string if nothing found.
    """
    if not text or not text.strip():
        return {}

    text_lower = text.lower()
    results = {}

    for group_name, group_config in KEYWORD_GROUPS.items():
        hits = set()  # (start, end) positions

        # Find keyword matches
        for kw in group_config["keywords"]:
            start = 0
            while True:
                idx = text_lower.find(kw.lower(), start)
                if idx < 0:
                    break
                chunk_start = max(0, idx - WINDOW_BEFORE)
                chunk_end = min(len(text), idx + len(kw) + WINDOW_AFTER)
                hits.add((chunk_start, chunk_end))
                start = idx + 1

        # Find pattern matches
        for pattern in group_config.get("patterns", []):
            for m in re.finditer(pattern, text_lower):
                chunk_start = max(0, m.start() - WINDOW_BEFORE)
                chunk_end = min(len(text), m.end() + WINDOW_AFTER)
                hits.add((chunk_start, chunk_end))

        if not hits:
            continue

        # Merge overlapping ranges
        merged = _merge_ranges(sorted(hits))

        # Extract and join chunks
        chunks = []
        total = 0
        for start, end in merged:
            chunk = text[start:end].strip()
            if chunk and total + len(chunk) <= max_total_chars:
                chunks.append(chunk)
                total += len(chunk)

        if chunks:
            results[group_name] = "\n---\n".join(chunks)

    return results


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Merge overlapping (start, end) ranges."""
    if not ranges:
        return []
    merged = [ranges[0]]
    for start, end in ranges[1:]:
        if start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def build_focused_context(crawled: dict, pdf_text: str | None) -> str:
    """Build a focused context block from all available content.

    Extracts keyword chunks from each source and groups them by field type.
    Falls back to raw truncated content if no keywords found.
    """
    all_prices = []
    all_deadlines = []
    all_distances = []

    sources = []
    if pdf_text:
        sources.append(("REGULAMIN", pdf_text))
    for field, content in crawled.items():
        label = {
            "registration_url": "REGISTRATION PAGE",
            "website": "WEBSITE",
            "regulamin_url": "REGULAMIN PAGE",
        }.get(field, field.upper())
        if content and isinstance(content, str):
            sources.append((label, content))

    for label, text in sources:
        chunks = extract_chunks(text)
        if chunks.get("prices"):
            all_prices.append(f"[{label}]\n{chunks['prices']}")
        if chunks.get("deadlines"):
            all_deadlines.append(f"[{label}]\n{chunks['deadlines']}")
        if chunks.get("distances"):
            all_distances.append(f"[{label}]\n{chunks['distances']}")

    sections = []
    if all_prices:
        sections.append("=== PRICE INFORMATION ===\n" + "\n\n".join(all_prices))
    if all_deadlines:
        sections.append("=== DEADLINE INFORMATION ===\n" + "\n\n".join(all_deadlines))
    if all_distances:
        sections.append("=== DISTANCE INFORMATION ===\n" + "\n\n".join(all_distances))

    if not sections:
        return ""

    return "\n\n".join(sections)
