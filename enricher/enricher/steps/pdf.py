import os
import tempfile
from typing import Optional
import httpx


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
    """Extract text from a PDF using Docling. Returns plain text or None."""
    try:
        text = _docling_extract(pdf_path)
        if not text or not text.strip():
            return None
        return text[:max_chars]
    except Exception:
        return None


def _docling_extract(pdf_path: str) -> str:
    """Call Docling to convert PDF to text."""
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(pdf_path)
    return result.document.export_to_markdown()


def cleanup_pdf(path: Optional[str]):
    """Remove temp PDF file if it exists."""
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass
