from PIL import Image

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
