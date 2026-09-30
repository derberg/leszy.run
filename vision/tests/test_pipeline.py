from PIL import Image

from vision.pipeline import Sighting, read_frame
from vision.synth.render import render_bib

FIXTURE = "tests/fixtures/runner.jpg"


def _person_wearing(number):
    image = Image.open(FIXTURE).convert("RGB").copy()
    bib = render_bib(number, px_per_mm=max(0.6, image.width / 900))
    image.paste(bib, (image.width // 2 - bib.width // 2, int(image.height * 0.45)))
    return image


def test_empty_scene_returns_an_empty_list_and_does_not_raise():
    assert read_frame(Image.new("RGB", (640, 480), (90, 110, 70))) == []


def test_reads_a_bib_worn_by_a_detected_person():
    assert any(s.text == "47" for s in read_frame(_person_wearing(47)))


def test_person_without_a_bib_yields_a_sighting_with_no_text():
    # The runner in a zipped jacket. The person is real, the number is not
    # readable, and that row is the lead an operator needs.
    sightings = read_frame(Image.open(FIXTURE))
    assert sightings
    assert all(isinstance(s, Sighting) for s in sightings)
    assert all(s.text is None for s in sightings)
