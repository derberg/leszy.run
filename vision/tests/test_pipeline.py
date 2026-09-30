from PIL import Image

from vision.pipeline import Sighting, read_frame
from vision.synth.render import render_bib

from tests.conftest import needs_detector

FIXTURE = "tests/fixtures/runner.jpg"


def _person_wearing(number):
    image = Image.open(FIXTURE).convert("RGB").copy()
    bib = render_bib(number, px_per_mm=max(0.6, image.width / 900))
    image.paste(bib, (image.width // 2 - bib.width // 2, int(image.height * 0.45)))
    return image


@needs_detector
def test_empty_scene_returns_an_empty_list_and_does_not_raise():
    assert read_frame(Image.new("RGB", (640, 480), (90, 110, 70))) == []


@needs_detector
def test_reads_a_bib_worn_by_a_detected_person():
    assert any(s.text == "47" for s in read_frame(_person_wearing(47)))


@needs_detector
def test_person_without_a_bib_yields_a_sighting_with_no_text():
    # The runner in a zipped jacket. The person is real, the number is not
    # readable, and that row is the lead an operator needs.
    sightings = read_frame(Image.open(FIXTURE))
    assert sightings
    assert all(isinstance(s, Sighting) for s in sightings)
    assert all(s.text is None for s in sightings)


@needs_detector
def test_one_bib_is_never_awarded_to_two_people():
    # Runner A's bib is covered by runner B's shoulder, and B's bib falls
    # inside A's detector box. locate_bib searches inside a person box and
    # has no idea whose bib it found, so without this both A and B are given
    # B's number, A at full confidence. A is silently handed B's time.
    from vision.pipeline import resolve_bib_claims

    shared = (430, 290, 677, 413)
    a_person = (300, 100, 700, 800)     # the bib sits off to one side
    b_person = (420, 260, 700, 760)     # the bib sits centrally

    resolved = resolve_bib_claims([(a_person, shared), (b_person, shared)])

    keepers = [p for p, bib in resolved if bib is not None]
    assert len(keepers) == 1
    assert keepers[0] == b_person


@needs_detector
def test_two_people_with_their_own_bibs_both_keep_them():
    from vision.pipeline import resolve_bib_claims

    a = ((100, 100, 300, 600), (150, 300, 250, 360))
    b = ((400, 100, 600, 600), (450, 300, 550, 360))
    resolved = resolve_bib_claims([a, b])
    assert [bib for _, bib in resolved] == [a[1], b[1]]
