"""Regulamin extraction for non-PDF, non-HTML sources: DOCX files and public
Google Drive folders (which hold per-distance regulamin PDFs/DOCX).

PDFs and plain HTML pages are handled elsewhere (pdf.py / crawl.py). This module
covers the two formats those paths miss:
  - `.docx`        — Word export, extracted with stdlib zip + XML (no external dep,
                     so it works the same natively and inside the enricher container
                     where macOS `textutil` is unavailable).
  - Drive folder   — a public "anyone with link" folder embeds its file manifest in
                     the page HTML; we pull every file id, download each via the
                     direct-download endpoint, extract per type, and concatenate.

A Drive *file* link (/file/d/<id> or ?id=<id>) is handled too, by rewriting it to
the same direct-download endpoint.
"""
import io
import re
import zipfile
from typing import Optional
from xml.sax.saxutils import unescape

import httpx

from enricher.steps.pdf import extract_pdf_text_from_bytes

_HEADERS = {"User-Agent": "leszy.run/1.0 (kontakt@leszy.run)"}


def classify_doc_url(url: str, content_type: str = "") -> str:
    """Classify a regulamin URL by URL shape + content-type.

    Returns 'pdf' | 'docx' | 'drive_folder' | 'drive_file' | 'html'.
    Drive folders/files are detected by URL pattern (their content-type is text/html);
    docx wins on a .docx path or a wordprocessingml content-type.
    """
    u = url.lower()
    path = u.split("?", 1)[0]
    ct = content_type.lower()
    if "/drive/folders/" in u:
        return "drive_folder"
    if "wordprocessingml" in ct or path.endswith(".docx"):
        return "docx"
    if "drive.google.com" in u and ("/file/d/" in u or "uc?" in u or "id=" in u):
        return "drive_file"
    if "pdf" in ct or path.endswith(".pdf"):
        return "pdf"
    return "html"


def _detect_buffer_kind(data: bytes, content_type: str, url: str) -> str:
    """Identify a downloaded buffer from magic bytes first, then hints."""
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:2] == b"PK":  # zip — Office Open XML (.docx) is a zip container
        u = url.lower()
        if u.split("?", 1)[0].endswith(".docx") or "wordprocessingml" in content_type.lower():
            return "docx"
        if b"word/" in data[:4000]:
            return "docx"
        return "unknown"
    if "pdf" in content_type.lower():
        return "pdf"
    return "unknown"


def extract_docx_text(data: bytes, max_chars: int = 15_000) -> Optional[str]:
    """Extract plain text from a .docx buffer using only the stdlib.

    A .docx is a zip; the body lives in word/document.xml as <w:t> runs grouped
    into <w:p> paragraphs. We turn paragraph/break/tab tags into whitespace, drop
    every other tag, and unescape XML entities. No python-docx / textutil needed.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
    except Exception:
        return None

    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:br\b[^>]*/?>", "\n", xml)
    xml = re.sub(r"<w:tab\b[^>]*/?>", "\t", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    text = unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:max_chars] if text else None


def _drive_folder_id(url: str) -> Optional[str]:
    m = re.search(r"/drive/folders/([0-9A-Za-z_-]+)", url)
    return m.group(1) if m else None


def _drive_file_id(url: str) -> Optional[str]:
    m = re.search(r"/file/d/([0-9A-Za-z_-]+)", url) or re.search(r"[?&]id=([0-9A-Za-z_-]+)", url)
    return m.group(1) if m else None


def _drive_download_url(file_id: str) -> str:
    return f"https://drive.google.com/uc?export=download&id={file_id}"


async def _fetch_bytes(url: str, timeout: int = 30) -> tuple[Optional[bytes], str]:
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            resp = await client.get(url, headers=_HEADERS)
        if resp.status_code >= 400:
            return None, ""
        return resp.content, resp.headers.get("content-type", "").lower()
    except Exception:
        return None, ""


def _extract_buffer(data: bytes, content_type: str, url: str, max_chars: int) -> Optional[str]:
    kind = _detect_buffer_kind(data, content_type, url)
    if kind == "pdf":
        return extract_pdf_text_from_bytes(data, max_chars)
    if kind == "docx":
        return extract_docx_text(data, max_chars)
    return None


async def extract_drive_folder_text(url: str, max_chars: int = 15_000) -> Optional[str]:
    """Download every document in a public Drive folder and concatenate their text."""
    html_bytes, _ = await _fetch_bytes(url)
    if not html_bytes:
        return None
    html = html_bytes.decode("utf-8", errors="ignore")
    ids = list(dict.fromkeys(re.findall(r'data-id="(1[0-9A-Za-z_-]{25,44})"', html)))
    if not ids:
        return None

    chunks = []
    budget = max_chars
    for file_id in ids:
        if budget <= 0:
            break
        data, ct = await _fetch_bytes(_drive_download_url(file_id))
        if not data or len(data) < 200:
            continue
        text = _extract_buffer(data, ct, "", budget)
        if text and len(text.strip()) > 50:
            kind = _detect_buffer_kind(data, ct, "")
            chunk = f"=== {file_id} ({kind}) ===\n{text.strip()}"
            chunks.append(chunk)
            budget -= len(chunk)
    if not chunks:
        return None
    return "\n\n".join(chunks)[:max_chars]


async def extract_regulamin_doc(url: str, kind: str, max_chars: int = 15_000) -> Optional[str]:
    """Extract regulamin text from a docx / drive_folder / drive_file URL.

    PDFs and HTML pages are NOT handled here — the pipeline routes those to
    download_pdf / crawl_pages respectively. Returns plain text or None.
    """
    if kind == "drive_folder":
        return await extract_drive_folder_text(url, max_chars)

    # Single file: a Drive file link gets rewritten to its direct-download URL.
    file_id = _drive_file_id(url)
    fetch_url = _drive_download_url(file_id) if file_id else url
    data, ct = await _fetch_bytes(fetch_url)
    if not data or len(data) < 200:
        return None
    return _extract_buffer(data, ct, url, max_chars)
