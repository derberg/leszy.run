from enricher.steps.audit_fetch import FastPage
from enricher.steps.audit_prompt import build_fast_prompt, build_full_prompt


def _sample_event():
    return {
        "id": "uuid-1",
        "name": "Bieg Leszka",
        "date": "2026-05-10",
        "location": "Warszawa",
        "voivodeship": "Mazowieckie",
        "distances": ["5 km", "10 km"],
    }


def test_fast_prompt_includes_event_facts():
    page = FastPage(
        url="https://x.pl",
        title="Bieg Leszka 2026",
        meta_description="Bieg w Warszawie",
        h1=["Bieg Leszka"],
        body_sample="Maj 2026, 5km i 10km",
    )
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "Bieg Leszka" in prompt
    assert "2026-05-10" in prompt
    assert "Warszawa" in prompt
    assert "Mazowieckie" in prompt
    assert "5 km" in prompt
    assert "10 km" in prompt


def test_fast_prompt_includes_page_content():
    page = FastPage(
        url="https://x.pl",
        title="My Title",
        meta_description="My Meta",
        h1=["H1a", "H1b"],
        body_sample="Body text here",
    )
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "My Title" in prompt
    assert "My Meta" in prompt
    assert "H1a" in prompt
    assert "H1b" in prompt
    assert "Body text here" in prompt


def test_fast_prompt_requests_specific_json_shape():
    page = FastPage(url="https://x.pl")
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "verdict" in prompt
    assert "confidence" in prompt
    assert "reasoning" in prompt
    # All three allowed verdict values must be named
    assert "match" in prompt
    assert "mismatch" in prompt
    assert "uncertain" in prompt


def test_fast_prompt_labels_which_field_is_being_audited():
    page = FastPage(url="https://x.pl")
    prompt = build_fast_prompt(_sample_event(), "website", "https://x.pl", page)
    assert "website" in prompt


def test_fast_prompt_handles_missing_event_fields():
    event = {"id": "x", "name": "Event", "date": "2026-05-10"}
    page = FastPage(url="https://x.pl")
    prompt = build_fast_prompt(event, "website", "https://x.pl", page)
    # Must not raise; fallback text like "unknown" acceptable
    assert "Event" in prompt


def test_full_prompt_uses_crawled_content():
    event = _sample_event()
    prompt = build_full_prompt(
        event,
        "website",
        "https://x.pl",
        crawled_content="Bieg Leszka 10 maja 2026 w Warszawie. 5 km i 10 km.",
        max_content_chars=5000,
    )
    assert "Bieg Leszka 10 maja 2026" in prompt
    assert "verdict" in prompt
    assert "website" in prompt


def test_full_prompt_truncates_long_content():
    event = _sample_event()
    long_text = "x" * 20000
    prompt = build_full_prompt(
        event, "website", "https://x.pl",
        crawled_content=long_text, max_content_chars=5000,
    )
    # The prompt must NOT contain the full 20k chars — only truncated
    assert prompt.count("x") <= 5000 + 100  # small slack for label text containing 'x'


def test_full_prompt_requests_json_shape():
    prompt = build_full_prompt(
        _sample_event(), "website", "https://x.pl",
        crawled_content="some content", max_content_chars=5000,
    )
    assert "match" in prompt
    assert "mismatch" in prompt
    assert "uncertain" in prompt
    assert "confidence" in prompt
