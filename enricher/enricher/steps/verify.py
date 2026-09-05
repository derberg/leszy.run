"""Relevance gate for search-discovered URLs.

A candidate that a search engine produced is confirmed against the content the
pipeline already holds, before `_merge_urls` is allowed to adopt it. Organizer-
declared and deterministically derived URLs never reach this module.

The gate deliberately does not call `audit.process_url`. That function fetches
the page again, and it classifies any non-HTML response as dead, so it cannot
judge a regulamin PDF at all.
"""
import re
import unicodedata
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from enricher.steps.audit_prompt import build_full_prompt
from enricher.steps.audit_verdict import call_audit_llm
from enricher.steps.navigate import page_matches_event


# Polish stopwords and event-generic terms that shouldn't count as distinctive
# matches between an event name and a URL slug.
_URL_SLUG_STOPWORDS = frozenset({
    # articles / generic
    "bieg", "biegu", "biegi", "run", "running", "race", "marathon",
    "polska", "polski", "edycja", "jubileuszowy", "międzynarodowy",
    # numerals often as roman or ordinals in names
    "pierwsza", "druga", "trzecia", "prima",
    # years
    "2024", "2025", "2026", "2027", "2028",
    # descriptors
    "open", "challenge", "festiwal", "cup", "grand", "prix",
})


_POLISH_FOLD = str.maketrans({
    "ą": "a", "Ą": "A",
    "ć": "c", "Ć": "C",
    "ę": "e", "Ę": "E",
    "ł": "l", "Ł": "L",
    "ń": "n", "Ń": "N",
    "ó": "o", "Ó": "O",
    "ś": "s", "Ś": "S",
    "ź": "z", "Ź": "Z",
    "ż": "z", "Ż": "Z",
})


def _normalize_for_slug_match(s: str) -> str:
    """Lowercase + fold Polish letters + strip combining marks.

    Makes "Kołobrzeska Odyseja" → "kolobrzeska odyseja" which substring-matches
    against "kolobrzeskaodyseja.pl" (after stripping non-alnum).

    Note: Polish `ł` / `ó` / `ś` etc. are precomposed codepoints that NFKD does
    NOT decompose, so we map them explicitly via a translation table.
    """
    import unicodedata
    s = s.translate(_POLISH_FOLD)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()


def url_slug_matches_event(url: str, event: dict) -> bool:
    """Return True if the URL's host+path contains at least 2 distinctive tokens
    from the event name (or 1 distinctive name-token + the location). Used to
    rescue `uncertain` verdicts when the URL strongly identifies the event.
    """
    import re
    from urllib.parse import urlparse

    name = _normalize_for_slug_match(event.get("name") or "")
    location = _normalize_for_slug_match(event.get("location") or "")
    u = urlparse(url)
    host_path = _normalize_for_slug_match((u.hostname or "") + " " + (u.path or ""))
    # Collapse everything to a letter-digit bag so "kolobrzeska-odyseja" and
    # "kolobrzeskaodyseja" both match.
    url_bag = re.sub(r"[^a-z0-9]+", "", host_path)
    if not url_bag:
        return False

    def _tokens(text: str):
        for t in re.split(r"\W+", text):
            if len(t) >= 4 and t not in _URL_SLUG_STOPWORDS:
                yield t

    name_hits = sum(1 for t in _tokens(name) if t in url_bag)
    loc_hits = sum(1 for t in _tokens(location) if t in url_bag)

    return name_hits >= 2 or (name_hits >= 1 and loc_hits >= 1)


@dataclass
class VerifyResult:
    """Outcome of one gate run. `ok` is the only field callers must honour."""
    ok: bool
    verdict: str          # match | mismatch | uncertain | no_content | error
    confidence: float
    reasoning: str
    llm_called: bool = False


def verify_search_candidate(
    event: dict,
    field: str,
    url: str,
    content: Optional[str],
    config,
) -> VerifyResult:
    """Confirm that a search-discovered URL belongs to this event.

    `content` is whatever the pipeline already extracted for the URL: crawled
    markdown for an HTML candidate, or the text pulled out of a PDF, a .docx or
    a Google Drive file. Passing extracted text rather than the raw response is
    what lets the gate judge a document candidate.

    Only a `match` verdict returns ok=True. Every other outcome drops the
    candidate, which leaves the field empty for a later run to retry.
    """
    if not content or not content.strip():
        return VerifyResult(
            ok=False, verdict="no_content", confidence=1.0,
            reasoning="No extracted content for the candidate, so it cannot be confirmed.",
        )

    # Free rejection first. The token check never approves a candidate on its
    # own: a name match says nothing about which edition the page describes, and
    # a previous year's page is the failure this gate exists to catch.
    if not page_matches_event(event, content):
        return VerifyResult(
            ok=False, verdict="mismatch", confidence=1.0,
            reasoning="Event name tokens are absent from the content.",
        )

    verdict = call_audit_llm(
        build_full_prompt(
            event, field, url,
            crawled_content=content,
            max_content_chars=config.max_page_chars,
        ),
        config,
    )

    if verdict is None:
        return VerifyResult(
            ok=False, verdict="error", confidence=0.0,
            reasoning="Verdict call failed or returned unparseable JSON.",
            llm_called=True,
        )

    if verdict.verdict == "uncertain" and url_slug_matches_event(url, event):
        return VerifyResult(
            ok=True, verdict="match",
            confidence=max(verdict.confidence, 0.75),
            reasoning=verdict.reasoning + " (promoted via URL-slug match)",
            llm_called=True,
        )

    return VerifyResult(
        ok=verdict.verdict == "match",
        verdict=verdict.verdict,
        confidence=verdict.confidence,
        reasoning=verdict.reasoning,
        llm_called=True,
    )
