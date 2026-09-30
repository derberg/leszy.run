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


def test_a_bright_strap_across_the_bib_does_not_become_a_digit():
    # A race belt, a reflective strap or white sponsor text across the block.
    # Emitting "147" for a bib that plainly says 47 hands a runner a number
    # that is not theirs, which is the failure that costs the most.
    from PIL import ImageDraw

    bib = render_bib(47, px_per_mm=2.0)
    draw = ImageDraw.Draw(bib)
    draw.rectangle([60, 25, 82, 165], fill=(250, 250, 250))
    text, _ = read_bib(bib)
    assert text != "147"


def test_digits_merged_by_heavy_blur_are_refused_not_guessed():
    # At high blur three digits collapse into one blob. Returning "1" for a
    # bib that says 188 is a confident lie; returning nothing is an honest
    # miss that a person can still resolve from the photograph.
    from PIL import ImageFilter

    blurred = render_bib(188, px_per_mm=2.0).filter(ImageFilter.GaussianBlur(9))
    text, _ = read_bib(blurred)
    assert text is None
