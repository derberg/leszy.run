from dataclasses import dataclass

import pytest

from enricher.steps import verify
from enricher.steps.audit_verdict import AuditVerdict


@dataclass
class FakeConfig:
    max_page_chars: int = 6000
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "gemma3:27b"
    ollama_temperature: float = 0.1
    ollama_max_tokens: int = 800


EVENT = {
    "name": "Kołobrzeska Odyseja",
    "date": "2026-10-11",
    "location": "Kołobrzeg",
    "voivodeship": "Zachodniopomorskie",
    "distances": "10 km, 21.1 km",
}

# Content carrying the event's distinctive tokens, so page_matches_event passes
# and the ladder reaches the model call.
MATCHING_CONTENT = (
    "Kołobrzeska Odyseja 2026 odbędzie się 11 października w Kołobrzegu. "
    "Dystanse: 10 km oraz 21,1 km. Zapisy trwają."
)


def _stub_llm(monkeypatch, verdict, confidence=0.9, reasoning="stub"):
    """Replace the model call and record how many times it ran."""
    calls = []

    def fake(prompt, config):
        calls.append(prompt)
        if verdict is None:
            return None
        return AuditVerdict(verdict=verdict, confidence=confidence, reasoning=reasoning)

    monkeypatch.setattr(verify, "call_audit_llm", fake)
    return calls


def test_match_keeps_candidate(monkeypatch):
    _stub_llm(monkeypatch, "match", confidence=0.95)
    res = verify.verify_search_candidate(
        EVENT, "regulamin_url", "https://example.pl/reg.pdf", MATCHING_CONTENT, FakeConfig()
    )
    assert res.ok is True
    assert res.verdict == "match"
    assert res.confidence == 0.95


def test_mismatch_drops_candidate(monkeypatch):
    _stub_llm(monkeypatch, "mismatch")
    res = verify.verify_search_candidate(
        EVENT, "regulamin_url", "https://example.pl/reg.pdf", MATCHING_CONTENT, FakeConfig()
    )
    assert res.ok is False
    assert res.verdict == "mismatch"


def test_uncertain_with_slug_hit_is_promoted(monkeypatch):
    _stub_llm(monkeypatch, "uncertain", confidence=0.4)
    res = verify.verify_search_candidate(
        EVENT, "registration_url", "https://kolobrzeskaodyseja.pl/zapisy",
        MATCHING_CONTENT, FakeConfig(),
    )
    assert res.ok is True
    assert res.verdict == "match"
    assert res.confidence == 0.75
    assert "URL-slug match" in res.reasoning


def test_uncertain_without_slug_hit_drops(monkeypatch):
    _stub_llm(monkeypatch, "uncertain", confidence=0.4)
    res = verify.verify_search_candidate(
        EVENT, "registration_url", "https://sportowe-zapisy.pl/event/8812",
        MATCHING_CONTENT, FakeConfig(),
    )
    assert res.ok is False
    assert res.verdict == "uncertain"


def test_absent_content_drops_without_model_call(monkeypatch):
    calls = _stub_llm(monkeypatch, "match")
    for empty in (None, "", "   "):
        res = verify.verify_search_candidate(
            EVENT, "regulamin_url", "https://example.pl/reg.pdf", empty, FakeConfig()
        )
        assert res.ok is False
        assert res.verdict == "no_content"
        assert res.llm_called is False
    assert calls == []


def test_token_rejection_skips_the_model(monkeypatch):
    """A page with none of the event's tokens costs nothing to reject."""
    calls = _stub_llm(monkeypatch, "match")
    res = verify.verify_search_candidate(
        EVENT, "regulamin_url", "https://rundazubra.pl/regulamin.pdf",
        "Runda Żubra to bieg przez Puszczę Białowieską. Dystans 21 km.",
        FakeConfig(),
    )
    assert res.ok is False
    assert res.verdict == "mismatch"
    assert res.llm_called is False
    assert calls == [], "token rejection must not reach the model"


def test_failed_model_call_drops(monkeypatch):
    _stub_llm(monkeypatch, None)
    res = verify.verify_search_candidate(
        EVENT, "regulamin_url", "https://example.pl/reg.pdf", MATCHING_CONTENT, FakeConfig()
    )
    assert res.ok is False
    assert res.verdict == "error"


def test_match_is_the_only_verdict_that_survives(monkeypatch):
    """Guards the rule the whole gate rests on."""
    survived = {}
    for v in ("match", "mismatch", "uncertain", "error"):
        _stub_llm(monkeypatch, None if v == "error" else v)
        res = verify.verify_search_candidate(
            EVENT, "regulamin_url", "https://sportowe-zapisy.pl/e/1",
            MATCHING_CONTENT, FakeConfig(),
        )
        survived[v] = res.ok
    assert survived == {"match": True, "mismatch": False, "uncertain": False, "error": False}


def test_document_text_is_judged_like_a_page(monkeypatch):
    """Extracted PDF text reaches the model, which raw bytes never could."""
    calls = _stub_llm(monkeypatch, "match")
    pdf_text = (
        "REGULAMIN\nKołobrzeska Odyseja\n11.10.2026, Kołobrzeg\n"
        "Dystanse: 10 km, 21,1 km\nOpłata startowa: 70 zł"
    )
    res = verify.verify_search_candidate(
        EVENT, "regulamin_url", "https://example.pl/statut.pdf", pdf_text, FakeConfig()
    )
    assert res.ok is True
    assert len(calls) == 1
    assert "Kołobrzeska Odyseja" in calls[0]


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://kolobrzeskaodyseja.pl/", True),
        ("https://example.pl/kolobrzeska-odyseja-2026", True),
        ("https://example.pl/bieg/8812", False),
    ],
)
def test_url_slug_matches_event(url, expected):
    assert verify.url_slug_matches_event(url, EVENT) is expected
