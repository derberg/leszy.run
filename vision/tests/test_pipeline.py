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


@needs_detector
def test_a_bib_held_beside_the_body_is_given_to_that_person():
    # A runner holding their number out in a hand: the detector boxes the
    # body, the bib sits outside the box, and it used to be lost entirely.
    runner = Image.open(FIXTURE).convert("RGB")
    canvas = Image.new("RGB", (runner.width * 2, runner.height), (60, 60, 60))
    canvas.paste(runner, (0, 0))
    bib = render_bib(47, px_per_mm=max(0.6, runner.width / 900))
    canvas.paste(bib, (runner.width + runner.width // 4, runner.height // 3))
    assert any(s.text == "47" for s in read_frame(canvas))


def test_one_bib_seen_from_two_person_boxes_is_one_claim(monkeypatch):
    # Two overlapping person boxes locate the same bib a few pixels apart.
    # As two bibs they started two tracks and split the reads between them.
    import vision.pipeline as pipeline

    boxes = iter([(693, 379, 938, 530), (696, 383, 941, 521)])
    monkeypatch.setattr(pipeline, "extract_bib",
                        lambda image, region=None: (next(boxes), Image.new("RGB", (4, 4))))
    claims, crops = pipeline.locate_claims(Image.new("RGB", (8, 8)), [(0, 0, 9, 9), (1, 1, 9, 9)])
    assert len(crops) == 1
    assert claims[0][1] == claims[1][1]
    resolved = pipeline.resolve_bib_claims(claims)
    assert sum(bib is not None for _, bib in resolved) == 1


def test_the_whole_frame_search_does_not_hand_a_held_bib_to_a_second_person(monkeypatch):
    # A poster the detector took for a person has no bib of its own. The
    # whole-frame search found the runner's bib again a few pixels off and
    # gave it to the poster, which then collected a vote from every runner.
    import vision.pipeline as pipeline

    def extract(image, region=None):
        if region == (278, 1, 1079, 1296):
            return (432, 475, 696, 624), Image.new("RGB", (4, 4))
        if region is None:
            return (434, 478, 696, 679), Image.new("RGB", (4, 4))
        return None, None

    monkeypatch.setattr(pipeline, "extract_bib", extract)
    claims, crops = pipeline.locate_claims(
        Image.new("RGB", (8, 8)), [(278, 1, 1079, 1296), (1029, 276, 1357, 790)])
    assert len(crops) == 1
    assert claims[1][1] is None
