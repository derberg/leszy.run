from PIL import Image

from vision.bib_spec import BIB
from vision.locate import locate_bib
from vision.synth.render import render_bib

FOREST = (90, 110, 70)


def _scene(bib_xy=(300, 220), bg=FOREST):
    """A bib pasted onto forest green, which is the camouflage case."""
    scene = Image.new("RGB", (900, 700), bg)
    bib = render_bib(47, px_per_mm=1.2)
    scene.paste(bib, bib_xy)
    box = (bib_xy[0], bib_xy[1], bib_xy[0] + bib.width, bib_xy[1] + bib.height)
    return scene, box


def test_finds_the_bib_against_forest_green():
    scene, truth = _scene()
    found = locate_bib(scene)
    assert found is not None
    for got, want in zip(found, truth):
        assert abs(got - want) < 25


def test_returns_none_when_there_is_no_bib():
    assert locate_bib(Image.new("RGB", (900, 700), FOREST)) is None


def test_region_restricts_the_search():
    scene, _ = _scene()
    # A region covering only the left edge excludes the bib pasted at x=300.
    assert locate_bib(scene, region=(0, 0, 200, 700)) is None


import pytest


@pytest.mark.parametrize("degrees", [5, 10, 15, 20])
def test_finds_a_tilted_bib(degrees):
    # A bib pinned to a moving runner swings, and the runner leans. The
    # camera sits at chest height looking down the lane, so ten degrees is
    # ordinary. A fill test against the axis-aligned bounding box rejects a
    # rotated rectangle, which would lose these runners entirely.
    scene = Image.new("RGB", (900, 700), FOREST)
    bib = render_bib(47, px_per_mm=1.2).rotate(
        degrees, expand=True, fillcolor=FOREST, resample=Image.BICUBIC
    )
    scene.paste(bib, (300, 220))
    assert locate_bib(scene) is not None


@pytest.mark.parametrize("degrees", [0, 10, 15, 20])
def test_a_tilted_bib_reads_correctly_after_deskew(degrees):
    # Locating a tilted bib is not enough. Read straight off the tilted crop,
    # 47 came back as 40 at ten degrees and 55 at twenty, at around 0.5
    # confidence. A located-but-misread bib is worse than a missed one.
    from vision.locate import extract_bib
    from vision.recognize import read_bib

    scene = Image.new("RGB", (900, 700), FOREST)
    bib = render_bib(47, px_per_mm=1.2).rotate(
        degrees, expand=True, fillcolor=FOREST, resample=Image.BICUBIC
    )
    scene.paste(bib, (300, 220))

    box, crop = extract_bib(scene)
    assert box is not None
    assert read_bib(crop)[0] == "47"


@pytest.mark.parametrize(
    "rect, want",
    [
        # An untilted block standing on its short edge. OpenCV 4.11 reports it
        # at +90 degrees and 4.14 at -90, the same rectangle either way. Both
        # need no rotation; turning the -90 form by 180 put the crop upside
        # down on the Pi and 47 read as 24.
        (((59.0, 199.0), 90.0), ((199.0, 59.0), 0.0)),
        (((59.0, 199.0), -90.0), ((199.0, 59.0), 0.0)),
        (((199.0, 59.0), 0.0), ((199.0, 59.0), 0.0)),
        # Ten degrees of tilt, described from either edge.
        (((59.0, 199.0), 80.0), ((199.0, 59.0), -10.0)),
        (((199.0, 59.0), 10.0), ((199.0, 59.0), 10.0)),
    ],
)
def test_upright_angle_is_the_smallest_correction(rect, want):
    from vision.locate import _upright

    (w, h), angle = _upright(*rect[0], rect[1])
    assert (w, h) == want[0]
    assert angle == pytest.approx(want[1])


def _as_photographed(image):
    """The bib face in the colours the camera recorded indoors.

    Measured on a real frame of bib 20, in OpenCV's 8-bit Lab: the printed
    block came back at (57, -7, 16) against the PDF's (128, -22, 55), about
    as chromatic as foliage. The digits stay the brightest thing on it.
    """
    import cv2
    import numpy as np

    block = cv2.cvtColor(np.uint8([[[57, 128 - 7, 128 + 16]]]),
                         cv2.COLOR_LAB2RGB)[0, 0]
    rgb = np.asarray(image.convert("RGB")).copy()
    is_block = (rgb == np.array(BIB.block_rgb, dtype=np.uint8)).all(axis=2)
    rgb[is_block] = block
    rgb[~is_block] = (rgb[~is_block] * 0.75).astype(np.uint8)
    return Image.fromarray(rgb)


def test_finds_a_bib_photographed_in_dull_light():
    from vision.locate import extract_bib
    from vision.recognize import read_bib

    scene = Image.new("RGB", (900, 700), (60, 60, 60))
    scene.paste(_as_photographed(render_bib(20, px_per_mm=1.5)), (300, 200))
    box, crop = extract_bib(scene)
    assert box is not None
    assert read_bib(crop)[0] == "20"


def test_dull_foliage_without_digits_is_not_a_bib():
    # The same dull olive as the photographed block, but nothing bright inside
    # it. Colour alone cannot tell them apart any more; the digits can.
    import cv2
    import numpy as np

    block = cv2.cvtColor(np.uint8([[[57, 128 - 7, 128 + 16]]]),
                         cv2.COLOR_LAB2RGB)[0, 0]
    scene = Image.new("RGB", (900, 700), (60, 60, 60))
    scene.paste(Image.new("RGB", (300, 150), tuple(int(v) for v in block)), (300, 200))
    assert locate_bib(scene) is None


def _printed_bib(number):
    """The block with the paper round it: a tall header, a short footer.

    Stand-ins for the lettering, sized as on the real bib: the header
    wordmark is set at 260 points and the footer at 150.
    """
    from PIL import ImageDraw

    block = render_bib(number, px_per_mm=1.2)
    w, h = block.size
    header, footer = int(h * 0.31), int(h * 0.2)
    bib = Image.new("RGB", (w, header + h + footer), (250, 250, 250))
    bib.paste(block, (0, header))
    draw = ImageDraw.Draw(bib)
    for i in range(6):
        x = 20 + i * (w - 40) // 6
        draw.rectangle([x, header * 0.2, x + 14, header * 0.2 + h * 0.2], fill=(30, 30, 40))
    for i in range(12):
        x = 20 + i * (w - 40) // 12
        draw.rectangle([x, header + h + footer * 0.3, x + 7, header + h + footer * 0.3 + h * 0.08],
                       fill=(30, 30, 40))
    return bib


@pytest.mark.parametrize("degrees, want", [(0, "upright"), (180, "flipped")])
def test_the_banners_say_which_way_up_the_bib_is(degrees, want):
    # A rectangle looks the same after half a turn, so the block alone cannot
    # tell a 6 from a 9 held upside down. A runner flipping the number in a
    # hand did exactly that and was read as 9.
    from vision.locate import extract_bib
    from vision.recognize import read_bib

    scene = Image.new("RGB", (900, 700), FOREST)
    scene.paste(_printed_bib(6).rotate(degrees), (250, 180))
    _, crop = extract_bib(scene)
    assert crop.info["orientation"] == want
    assert read_bib(crop)[0] == "6"


def test_a_bare_block_has_no_proven_orientation():
    from vision.locate import extract_bib

    scene, _ = _scene()
    _, crop = extract_bib(scene)
    assert crop.info["orientation"] is None



def _at_dusk(image, factor=0.28):
    """The scene as the gate camera recorded it after sunset.

    Measured on the 2026-10-15 test race: with gain and shutter both at their
    ceiling the bib block came back at saturation about 91 and value about 16
    of 255. That is below the relaxed colour mask's value floor of 20, and
    too unsaturated for the strict one, so no block was located. Scaling
    every channel keeps hue and saturation and lowers only the value: the
    dull-light block here goes from 56 to about 16.
    """
    import numpy as np

    rgb = np.asarray(image.convert("RGB")).astype(np.float32) * factor
    return Image.fromarray(rgb.astype(np.uint8))


def test_finds_and_reads_a_bib_at_dusk():
    from vision.locate import extract_bib
    from vision.recognize import read_bib

    scene = Image.new("RGB", (900, 700), (60, 60, 60))
    scene.paste(_as_photographed(render_bib(20, px_per_mm=1.5)), (300, 200))
    box, crop = extract_bib(_at_dusk(scene), region=(150, 50, 750, 650))
    assert box is not None
    assert read_bib(crop)[0] == "20"


def test_dark_foliage_without_digits_is_still_not_a_bib():
    import cv2
    import numpy as np

    block = cv2.cvtColor(np.uint8([[[57, 128 - 7, 128 + 16]]]),
                         cv2.COLOR_LAB2RGB)[0, 0]
    scene = Image.new("RGB", (900, 700), (60, 60, 60))
    scene.paste(Image.new("RGB", (300, 150), tuple(int(v) for v in block)), (300, 200))
    assert locate_bib(_at_dusk(scene), region=(150, 50, 750, 650)) is None
