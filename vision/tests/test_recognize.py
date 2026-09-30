import pytest
from PIL import Image, ImageDraw, ImageFont

from vision.bib_spec import BIB
from vision.recognize import read_bib, segment_digits
from vision.synth.render import find_font, render_bib


def render_bib_text(text: str, size=(380, 190)):
    """render_bib takes an int, so build the string cases directly.

    A leading zero and a four digit number cannot be expressed as an int
    argument, and both are cases the recognizer must not mangle.
    """
    im = Image.new("RGB", size, BIB.block_rgb)
    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype(find_font(), 120)
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((size[0] - (box[2] - box[0])) // 2 - box[0],
         (size[1] - (box[3] - box[1])) // 2 - box[1]),
        text, font=font, fill=BIB.digit_rgb,
    )
    return im


@pytest.mark.parametrize("number,expected", [(1, 1), (47, 2), (100, 3), (999, 3)])
def test_segments_the_right_number_of_digits(number, expected):
    assert len(segment_digits(render_bib(number, px_per_mm=2.0))) == expected


def test_reads_a_clean_render():
    text, confidence = read_bib(render_bib(47, px_per_mm=2.0))
    assert text == "47"
    assert confidence > 0.5


def test_preserves_a_leading_zero():
    # "047" and "47" are different bibs. Returning an int would lose this.
    text, _ = read_bib(render_bib_text("047"))
    assert text == "047"


def test_reads_a_four_digit_number_without_truncating():
    text, _ = read_bib(render_bib_text("1234"))
    assert text == "1234"


def test_returns_none_on_an_empty_block():
    blank = Image.new("RGB", (380, 190), BIB.block_rgb)
    text, confidence = read_bib(blank)
    assert text is None
    assert confidence == 0.0
