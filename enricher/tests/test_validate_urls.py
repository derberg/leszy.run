import httpx
import pytest
import respx
from enricher.steps.validate_urls import validate_urls, UrlStatus


def test_alive_url():
    with respx.mock:
        respx.head("https://example.pl/zapisy").mock(return_value=httpx.Response(200))
        result = validate_urls({"registration_url": "https://example.pl/zapisy"})
    assert result["registration_url"].status == "alive"


def test_dead_url():
    with respx.mock:
        respx.head("https://example.pl/gone").mock(return_value=httpx.Response(404))
        result = validate_urls({"registration_url": "https://example.pl/gone"})
    assert result["registration_url"].status == "dead"


def test_redirect_url():
    with respx.mock:
        respx.head("https://old.pl/zapisy").mock(
            return_value=httpx.Response(301, headers={"location": "https://new.pl/zapisy"})
        )
        respx.head("https://new.pl/zapisy").mock(return_value=httpx.Response(200))
        result = validate_urls({"registration_url": "https://old.pl/zapisy"})
    assert result["registration_url"].status == "alive"
    assert result["registration_url"].final_url == "https://new.pl/zapisy"


def test_timeout_url():
    with respx.mock:
        respx.head("https://slow.pl").mock(side_effect=httpx.TimeoutException("timeout"))
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
        result = validate_urls({"regulamin_url": "https://example.pl/rules"})
    assert result["regulamin_url"].status == "alive"
    assert result["regulamin_url"].is_pdf is False


def test_skips_none_urls():
    result = validate_urls({"registration_url": None, "website": None})
    assert len(result) == 0


def test_regulamin_urls_array():
    with respx.mock:
        respx.head("https://a.pl/reg.pdf").mock(
            return_value=httpx.Response(200, headers={"content-type": "application/pdf"})
        )
        respx.head("https://b.pl/reg.pdf").mock(return_value=httpx.Response(404))
        result = validate_urls({"regulamin_urls": ["https://a.pl/reg.pdf", "https://b.pl/reg.pdf"]})
    assert result["regulamin_urls[0]"].status == "alive"
    assert result["regulamin_urls[1]"].status == "dead"
