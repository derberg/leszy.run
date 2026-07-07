import io
import zipfile

from enricher.steps.docs import (
    classify_doc_url,
    extract_docx_text,
    _detect_buffer_kind,
    _drive_folder_id,
    _drive_file_id,
)


def _make_docx(paragraphs: list[str]) -> bytes:
    """Build a minimal valid .docx (zip with word/document.xml) in memory."""
    body = "".join(
        f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs
    )
    doc = (
        '<?xml version="1.0"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def test_extract_docx_text_basic():
    data = _make_docx(["Regulamin biegu", "Dystans: 21 km", "Opłata: 50 zł"])
    text = extract_docx_text(data)
    assert "Regulamin biegu" in text
    assert "21 km" in text
    assert "50 zł" in text
    # paragraphs become separate lines
    assert text.splitlines()[0] == "Regulamin biegu"


def test_extract_docx_text_unescapes_entities():
    data = _make_docx(["Bieg &amp; Marsz", "5 &lt; 10"])
    text = extract_docx_text(data)
    assert "Bieg & Marsz" in text
    assert "5 < 10" in text


def test_extract_docx_text_polish_diacritics():
    data = _make_docx(["PRZEŁAZY Świebodzin półmaraton"])
    assert "PRZEŁAZY Świebodzin półmaraton" in extract_docx_text(data)


def test_extract_docx_text_garbage_returns_none():
    assert extract_docx_text(b"not a zip at all") is None


def test_classify_doc_url():
    assert classify_doc_url("https://x.pl/regulamin.docx") == "docx"
    assert classify_doc_url("https://x.pl/r.pdf") == "pdf"
    assert classify_doc_url("https://x.pl/reg", "application/pdf") == "pdf"
    assert classify_doc_url(
        "https://x.pl/file", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) == "docx"
    assert classify_doc_url("https://drive.google.com/drive/folders/1ABC") == "drive_folder"
    assert classify_doc_url("https://drive.google.com/file/d/1ABC/view") == "drive_file"
    assert classify_doc_url("https://velostrefa.pl/regulamin100km", "text/html") == "html"
    # query string after .docx must still classify as docx
    assert classify_doc_url("https://x.pl/reg.docx?v=2") == "docx"


def test_detect_buffer_kind_magic_bytes():
    assert _detect_buffer_kind(b"%PDF-1.4\n...", "", "x.pdf") == "pdf"
    docx = _make_docx(["hi"])
    assert _detect_buffer_kind(docx, "", "x.docx") == "docx"
    # a zip without a .docx hint but containing word/ is still docx
    assert _detect_buffer_kind(docx, "", "") == "docx"
    assert _detect_buffer_kind(b"<html>...", "text/html", "x") == "unknown"


def test_drive_id_extraction():
    assert _drive_folder_id("https://drive.google.com/drive/folders/1Nj9X?usp=drive_link") == "1Nj9X"
    assert _drive_file_id("https://drive.google.com/file/d/1ABCdef/view") == "1ABCdef"
    assert _drive_file_id("https://drive.google.com/uc?export=download&id=1XYZ") == "1XYZ"
    assert _drive_file_id("https://example.pl/regulamin.pdf") is None
