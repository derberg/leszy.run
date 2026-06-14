import os
import re
import tempfile
from typing import Optional
import httpx

# Threshold: if ≥30% of adjacent character pairs are letter-space-letter,
# the PDF used a spaced-character encoding (common in some Polish Word→PDF
# exports from rajsportactive.pl and similar sources). In this encoding each
# glyph is stored as a separate text-run with a space between them, so pypdf
# extracts "o p ł a t a  s t a r t o w a" instead of "opłata startowa".
_SPACED_SAMPLE = 2000
_SPACED_THRESHOLD = 0.30
_LETTER_RE = re.compile(r"[A-Za-zÀ-ɏ]")  # latin + Polish letters


def _is_spaced_encoded(text: str) -> bool:
    sample = text[:_SPACED_SAMPLE]
    pairs = sum(
        1 for i in range(len(sample) - 2)
        if _LETTER_RE.match(sample[i]) and sample[i + 1] == " " and _LETTER_RE.match(sample[i + 2])
    )
    letters = sum(1 for c in sample if _LETTER_RE.match(c))
    return letters > 20 and pairs / max(letters, 1) >= _SPACED_THRESHOLD


def _normalize_spaced_text(text: str) -> str:
    """Collapse inter-character spaces in spaced-encoded PDF text.

    The encoding puts one space between every glyph and two spaces between
    words. Strategy: split each line on 2+ spaces (word boundaries), then
    strip all remaining spaces within each token (removes intra-glyph gaps).
    """
    lines = []
    for line in text.split("\n"):
        tokens = re.split(r"  +", line)
        normalized = [tok.replace(" ", "") for tok in tokens if tok.replace(" ", "")]
        lines.append(" ".join(normalized))
    return "\n".join(lines)


async def download_pdf(url: str, timeout: int = 30) -> Optional[str]:
    """Download a PDF to a temp file. Returns path or None on failure."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": "leszy.run/1.0 (kontakt@leszy.run)"},
            )
        if resp.status_code >= 400:
            return None

        content_type = resp.headers.get("content-type", "")
        if "pdf" not in content_type.lower():
            return None

        data = resp.content
        if len(data) < 500:
            return None

        # Detect HTML served as PDF
        head = data[:100].decode("utf-8", errors="ignore").strip()
        if head.lower().startswith("<!doctype") or head.lower().startswith("<html"):
            return None

        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(data)
        tmp.close()
        return tmp.name

    except Exception:
        return None


def extract_pdf_text(pdf_path: str, max_chars: int = 15_000) -> Optional[str]:
    """Extract text from a text-based PDF (regulamin) via pypdf.

    Earlier the enricher used Docling. Two problems made it unsuitable here:
      1. Default Docling pipeline runs easyocr (PyTorch). On top of the
         chromium/playwright/crawl4ai stack already loaded, PyTorch's TLS
         init trips a glibc dl-tls.c assertion and aborts the worker.
      2. Setting do_ocr=False sidesteps the crash but Docling then returns
         0 chars for many PDFs that DO have a text layer (verified on the
         "Pogoni za Bobrem" + "Cross Trzeźwości" regulamins, both of which
         pdftotext/pypdf extract perfectly). Net result: silent loss of
         price/deadline data.

    Polish regulamins are essentially always Word→PDF exports with a clean
    text layer. pypdf reads that text layer directly: fast, deterministic,
    no ML stack, no native deps. We don't need Docling's table layout
    reconstruction — the downstream regex_prepass and LLM consume plain
    text and look for `\\d+ zł` / "do dnia ..." substrings, which pypdf
    output preserves.
    """
    try:
        from pypdf import PdfReader
        return _reader_to_text(PdfReader(pdf_path), max_chars)
    except Exception:
        return None


def extract_pdf_text_from_bytes(data: bytes, max_chars: int = 15_000) -> Optional[str]:
    """Same as extract_pdf_text but from an in-memory buffer (no temp file).

    Used when a PDF arrives as bytes we already hold — e.g. a file pulled out of
    a Google Drive folder — so we don't round-trip through disk.
    """
    import io
    try:
        from pypdf import PdfReader
        return _reader_to_text(PdfReader(io.BytesIO(data)), max_chars)
    except Exception:
        return None


def _reader_to_text(reader, max_chars: int) -> Optional[str]:
    parts = []
    total = 0
    for page in reader.pages:
        text = page.extract_text() or ""
        parts.append(text)
        total += len(text)
        if total >= max_chars:
            break
    joined = "\n".join(parts)
    if not joined.strip():
        return None
    if _is_spaced_encoded(joined):
        joined = _normalize_spaced_text(joined)
    return joined[:max_chars]


def cleanup_pdf(path: Optional[str]):
    """Remove temp PDF file if it exists."""
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass
