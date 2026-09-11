import tempfile
import os
import pytest
from unittest.mock import patch, MagicMock
from enricher.steps.pdf import extract_pdf_text, download_pdf


def test_download_pdf_rejects_html():
    """HTML served as PDF should be rejected."""
    html_content = b"<!DOCTYPE html><html><body>Not a PDF</body></html>"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(html_content)
        f.flush()
        result = _check_file_is_pdf(f.name)
    os.unlink(f.name)
    assert result is False


def test_download_pdf_rejects_tiny():
    """Files under 500 bytes are likely broken."""
    tiny = b"%PDF-1.4 tiny"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(tiny)
        f.flush()
        is_valid = len(tiny) >= 500
    os.unlink(f.name)
    assert is_valid is False


def _fake_reader(*page_texts):
    """Stand-in for pypdf.PdfReader — only .pages[].extract_text() is consumed."""
    reader = MagicMock()
    pages = []
    for text in page_texts:
        page = MagicMock()
        page.extract_text.return_value = text
        pages.append(page)
    reader.pages = pages
    return reader


def test_extract_pdf_text_truncates():
    """Output should be capped at max_chars.

    Patches pypdf.PdfReader rather than a module-private helper: extraction moved from
    Docling to pypdf (Docling's easyocr/PyTorch stack aborted the worker, and disabling
    OCR made it return 0 chars for PDFs that do have a text layer), so the old
    _docling_extract patch target no longer existed and this test errored.
    """
    long_text = "Lorem ipsum " * 5000  # ~60k chars
    with patch("pypdf.PdfReader", return_value=_fake_reader(long_text)):
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert len(result) <= 15_000


def test_extract_pdf_text_joins_pages_in_order():
    with patch("pypdf.PdfReader", return_value=_fake_reader("page one", "page two")):
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert result == "page one\npage two"


def test_extract_pdf_text_returns_none_on_failure():
    with patch("pypdf.PdfReader", side_effect=Exception("pypdf crash")):
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert result is None


def test_extract_pdf_text_returns_none_for_empty_text_layer():
    """A scanned PDF extracts to whitespace — that is None, not an empty string.

    Downstream treats None as "no regulamin text available" and skips extraction
    rather than asking the model to invent a fee from nothing.
    """
    with patch("pypdf.PdfReader", return_value=_fake_reader("", "   \n  ")):
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert result is None


def _check_file_is_pdf(path):
    """Helper to check if file starts with PDF header."""
    with open(path, "rb") as f:
        head = f.read(100)
    return head[:5] == b"%PDF-"
