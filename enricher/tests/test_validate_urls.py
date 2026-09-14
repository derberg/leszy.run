import httpx
import pytest
import respx
from enricher.steps.validate_urls import validate_urls, UrlStatus

# A HEAD that carries no content-length proves nothing about the body, so validate_urls
# confirms HTML pages with a GET. Mock that GET with a real page or the URL reads dead.
PAGE = b"<html><body><h1>Bieg</h1><p>Regulamin biegu</p></body></html>"


def test_alive_url():
    with respx.mock:
        respx.head("https://example.pl/zapisy").mock(return_value=httpx.Response(200))
        respx.get("https://example.pl/zapisy").mock(
            return_value=httpx.Response(200, content=PAGE)
        )
        result = validate_urls({"registration_url": "https://example.pl/zapisy"})
    assert result["registration_url"].status == "alive"


def test_dead_url():
    # validate_urls retries with GET whenever HEAD fails or returns >= 400, because many
    # Polish event CMSes answer 403/405 to HEAD but 200 to GET. Both verbs must be mocked
    # or respx raises AllMockedAssertionError on the unmocked GET.
    with respx.mock:
        respx.head("https://example.pl/gone").mock(return_value=httpx.Response(404))
        respx.get("https://example.pl/gone").mock(return_value=httpx.Response(404))
        result = validate_urls({"registration_url": "https://example.pl/gone"})
    assert result["registration_url"].status == "dead"


def test_head_rejected_but_get_succeeds_is_alive():
    """The reason the GET fallback exists: HEAD 405, GET 200 — the site works."""
    with respx.mock:
        respx.head("https://joomla.pl/zapisy").mock(return_value=httpx.Response(405))
        respx.get("https://joomla.pl/zapisy").mock(
            return_value=httpx.Response(200, content=PAGE)
        )
        result = validate_urls({"registration_url": "https://joomla.pl/zapisy"})
    assert result["registration_url"].status == "alive"


def test_redirect_url():
    with respx.mock:
        respx.head("https://old.pl/zapisy").mock(
            return_value=httpx.Response(301, headers={"location": "https://new.pl/zapisy"})
        )
        respx.head("https://new.pl/zapisy").mock(return_value=httpx.Response(200))
        respx.get("https://new.pl/zapisy").mock(
            return_value=httpx.Response(200, content=PAGE)
        )
        result = validate_urls({"registration_url": "https://old.pl/zapisy"})
    assert result["registration_url"].status == "alive"
    assert result["registration_url"].final_url == "https://new.pl/zapisy"


def test_timeout_url():
    with respx.mock:
        respx.head("https://slow.pl").mock(side_effect=httpx.TimeoutException("timeout"))
        respx.get("https://slow.pl").mock(side_effect=httpx.TimeoutException("timeout"))
        result = validate_urls({"website": "https://slow.pl"})
    assert result["website"].status == "dead"


def test_pdf_content_type():
    with respx.mock:
        respx.head("https://example.pl/reg.pdf").mock(
            return_value=httpx.Response(200, headers={"content-type": "application/pdf"})
        )
        result = validate_urls({"regulamin_url": "https://example.pl/reg.pdf"})
    assert result["regulamin_url"].status == "alive"
    assert result["regulamin_url"].is_pdf is True


def test_regulamin_not_pdf():
    with respx.mock:
        respx.head("https://example.pl/rules").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/html"})
        )
        respx.get("https://example.pl/rules").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/html"}, content=PAGE)
        )
        result = validate_urls({"regulamin_url": "https://example.pl/rules"})
    assert result["regulamin_url"].status == "alive"
    assert result["regulamin_url"].is_pdf is False


def test_empty_body_html_page_is_dead():
    """VII Bieg Pocztyliona: http://www.kaszubybiegaja.pl/28-regulamin answers HEAD 200
    with no content-length and GET 200 with content-length 0. Called alive, the page is
    never re-searched and the crawler reads zero bytes, so registration_deadline stays
    null. A page with no body is dead.
    """
    with respx.mock:
        respx.head("http://kaszuby.pl/28-regulamin").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/html"})
        )
        respx.get("http://kaszuby.pl/28-regulamin").mock(
            return_value=httpx.Response(
                200, headers={"content-type": "text/html", "content-length": "0"}, content=b""
            )
        )
        result = validate_urls({"regulamin_url": "http://kaszuby.pl/28-regulamin"})
    assert result["regulamin_url"].status == "dead"


def test_stub_error_body_is_dead():
    """elektronicznezapisy.pl serves a deleted regulamin as HTTP 200 with the 30 byte
    body "Error: brak pliku na serwerze." — no file, but a 200. 12 future events point
    at such a link.
    """
    with respx.mock:
        respx.head("https://elektronicznezapisy.pl/download/abc/open").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/html"})
        )
        respx.get("https://elektronicznezapisy.pl/download/abc/open").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/html"},
                content="Error: brak pliku na serwerze.".encode(),
            )
        )
        result = validate_urls({"regulamin_url": "https://elektronicznezapisy.pl/download/abc/open"})
    assert result["regulamin_url"].status == "dead"


def test_html_page_with_content_is_alive():
    """The other half of the same rule: a HEAD that proves nothing plus a GET that
    returns a real page is still alive.
    """
    with respx.mock:
        respx.head("http://kaszuby.pl/regulamin").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/html"})
        )
        respx.get("http://kaszuby.pl/regulamin").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/html"},
                content=b"<html><body><h1>Regulamin biegu</h1></body></html>",
            )
        )
        result = validate_urls({"regulamin_url": "http://kaszuby.pl/regulamin"})
    assert result["regulamin_url"].status == "alive"


def test_pdf_with_content_length_is_not_downloaded():
    """A HEAD that already proves a body exists must not trigger a second request —
    validating a regulamin must not download the whole PDF.
    """
    with respx.mock:
        route = respx.head("https://example.pl/reg.pdf").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "application/pdf", "content-length": "48210"},
            )
        )
        result = validate_urls({"regulamin_url": "https://example.pl/reg.pdf"})
    assert result["regulamin_url"].status == "alive"
    assert route.call_count == 1


def test_skips_none_urls():
    result = validate_urls({"registration_url": None, "website": None})
    assert len(result) == 0


def test_regulamin_urls_array():
    with respx.mock:
        respx.head("https://a.pl/reg.pdf").mock(
            return_value=httpx.Response(200, headers={"content-type": "application/pdf"})
        )
        respx.head("https://b.pl/reg.pdf").mock(return_value=httpx.Response(404))
        respx.get("https://b.pl/reg.pdf").mock(return_value=httpx.Response(404))
        result = validate_urls({"regulamin_urls": ["https://a.pl/reg.pdf", "https://b.pl/reg.pdf"]})
    assert result["regulamin_urls[0]"].status == "alive"
    assert result["regulamin_urls[1]"].status == "dead"
