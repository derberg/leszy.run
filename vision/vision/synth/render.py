"""Render a leszy.run bib block with a given number.

The real bibs come out of ReportLab into leszy_bibs_light.pdf. This reproduces
the number block only. Branding above and below it falls outside the crop the
locator returns, so rendering it would train the recognizer on pixels it never
meets.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from vision.bib_spec import BIB

BUNDLED_FONT = Path(__file__).resolve().parents[2] / "fonts" / "BarlowCondensed-ExtraBold.ttf"

# The bundled face is the one the real bibs use. The fallbacks keep the package
# usable on a machine without it, at the cost of training on glyph shapes that
# are not quite the ones the camera will see.
FONT_CANDIDATES = [
    BUNDLED_FONT,
    Path("/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"),
]


def find_font() -> str:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError(
        "No condensed bold font found. Run: curl -sfL -o fonts/"
        "BarlowCondensed-ExtraBold.ttf https://github.com/google/fonts/raw/"
        "main/ofl/barlowcondensed/BarlowCondensed-ExtraBold.ttf"
    )


def _fit_font(draw, text, target_h, font_path):
    """Size the font so the drawn glyphs are target_h tall.

    Point size and rendered digit height are different numbers, and the gap
    between them varies by face, so this converges on the drawn height instead
    of trusting the point size.
    """
    size = max(1, int(target_h))
    for _ in range(40):
        font = ImageFont.truetype(font_path, size)
        box = draw.textbbox((0, 0), text, font=font)
        drawn = box[3] - box[1]
        if drawn == 0 or abs(drawn - target_h) <= 1:
            return font
        size = max(1, round(size * target_h / drawn))
    return ImageFont.truetype(font_path, size)


def render_bib(number: int, px_per_mm: float = 4.0) -> Image.Image:
    w = int(BIB.block_w_mm * px_per_mm)
    h = int(BIB.block_h_mm * px_per_mm)
    im = Image.new("RGB", (w, h), BIB.block_rgb)
    draw = ImageDraw.Draw(im)

    text = str(number)
    font = _fit_font(draw, text, BIB.digit_height_mm * px_per_mm, find_font())
    box = draw.textbbox((0, 0), text, font=font)
    x = (w - (box[2] - box[0])) // 2 - box[0]
    y = (h - (box[3] - box[1])) // 2 - box[1]
    draw.text((x, y), text, font=font, fill=BIB.digit_rgb)

    mark = int(BIB.corner_mark_mm * px_per_mm)
    inset = mark // 2
    corners = (
        (inset, inset, 1, 1),
        (w - inset, inset, -1, 1),
        (inset, h - inset, 1, -1),
        (w - inset, h - inset, -1, -1),
    )
    for cx, cy, dx, dy in corners:
        draw.line([(cx, cy), (cx + dx * mark, cy)], fill=BIB.digit_rgb, width=2)
        draw.line([(cx, cy), (cx, cy + dy * mark)], fill=BIB.digit_rgb, width=2)
    return im
