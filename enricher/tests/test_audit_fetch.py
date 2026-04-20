import httpx
import respx
import pytest
from enricher.steps.audit_fetch import fetch_fast, parse_html, FastPage


def test_parse_html_extracts_title_meta_h1_body():
    html = """
    <html>
      <head>
        <title>Maraton Warszawski 2026</title>
        <meta name="description" content="Najstarszy maraton w Polsce">
      </head>
      <body>
        <h1>Maraton Warszawski</h1>
        <p>Zapraszamy na 48. edycję biegu w Warszawie, 20 kwietnia 2026.</p>
        <p>Dystans: 42.195 km</p>
      </body>
    </html>
    """
    page = parse_html(html, body_chars=500)
    assert page.title == "Maraton Warszawski 2026"
    assert page.meta_description == "Najstarszy maraton w Polsce"
    assert page.h1 == ["Maraton Warszawski"]
    assert "48. edycję" in page.body_sample
    assert len(page.body_sample) <= 500


def test_parse_html_multiple_h1_capped():
    html = "<html><body>" + "".join(f"<h1>H{i}</h1>" for i in range(10)) + "</body></html>"
    page = parse_html(html, body_chars=200)
    assert len(page.h1) <= 5  # cap at 5


def test_parse_html_missing_fields_returns_empty_strings():
    page = parse_html("<html><body>hello</body></html>", body_chars=100)
    assert page.title == ""
    assert page.meta_description == ""
    assert page.h1 == []
    assert page.body_sample == "hello"


def test_parse_html_strips_scripts_and_styles():
    html = """
    <html><body>
      <script>alert('x')</script>
      <style>.a{color:red}</style>
      <p>Real content</p>
    </body></html>
    """
    page = parse_html(html, body_chars=500)
    assert "alert" not in page.body_sample
    assert "color:red" not in page.body_sample
    assert "Real content" in page.body_sample


def test_fetch_fast_success():
    with respx.mock:
        respx.get("https://example.pl").mock(
            return_value=httpx.Response(
                200,
                text="<html><head><title>T</title></head><body><p>body text here</p></body></html>",
                headers={"content-type": "text/html; charset=utf-8"},
            )
        )
        page = fetch_fast("https://example.pl", timeout=5, body_chars=200)
    assert page is not None
    assert page.title == "T"
    assert page.status == "ok"
    assert page.final_url == "https://example.pl"


def test_fetch_fast_404_returns_dead_status():
    with respx.mock:
        respx.get("https://example.pl/gone").mock(return_value=httpx.Response(404))
        page = fetch_fast("https://example.pl/gone", timeout=5, body_chars=200)
    assert page is not None
    assert page.status == "dead"
    assert page.http_status == 404


def test_fetch_fast_timeout_returns_dead_status():
    with respx.mock:
        respx.get("https://slow.pl").mock(side_effect=httpx.TimeoutException("timeout"))
        page = fetch_fast("https://slow.pl", timeout=1, body_chars=200)
    assert page is not None
    assert page.status == "dead"
    assert page.error and "timeout" in page.error.lower()


def test_fetch_fast_non_html_content_type_marks_dead():
    with respx.mock:
        respx.get("https://example.pl/file.pdf").mock(
            return_value=httpx.Response(
                200,
                content=b"%PDF-1.4 binary",
                headers={"content-type": "application/pdf"},
            )
        )
        page = fetch_fast("https://example.pl/file.pdf", timeout=5, body_chars=200)
    assert page.status == "dead"
    assert page.error == "non-html content"
