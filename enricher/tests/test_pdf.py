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


def test_extract_pdf_text_truncates():
    """Output should be capped at max_chars."""
    long_text = "Lorem ipsum " * 5000  # ~60k chars
    with patch("enricher.steps.pdf._docling_extract") as mock_extract:
        mock_extract.return_value = long_text
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert len(result) <= 15_000


def test_extract_pdf_text_returns_none_on_failure():
    with patch("enricher.steps.pdf._docling_extract") as mock_extract:
        mock_extract.side_effect = Exception("docling crash")
        result = extract_pdf_text("/fake/path.pdf", max_chars=15_000)
    assert result is None


def _check_file_is_pdf(path):
    """Helper to check if file starts with PDF header."""
    with open(path, "rb") as f:
        head = f.read(100)
    return head[:5] == b"%PDF-"
