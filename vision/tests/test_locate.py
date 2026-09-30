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
