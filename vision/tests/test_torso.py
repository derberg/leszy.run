import numpy as np
from PIL import Image

from vision import pipeline, torso
from vision.torso import BLANK, decode, torso_box


def _probs(labels, sure=0.99):
    out = np.full((3, 11), (1 - sure) / 10)
    for i, label in enumerate(labels):
        out[i, label] = sure
    return out


def test_a_number_is_read_right_aligned():
    assert decode(_probs([BLANK, 4, 7])) == ("47", 0.99)
    assert decode(_probs([1, 8, 5]))[0] == "185"


def test_no_bib_votes_against_a_number():
    # A spectator standing at the line for minutes must not be given a
    # number by two stray frames out of hundreds.
    text, confidence = decode(_probs([BLANK, BLANK, BLANK]))
    assert text is None and confidence == torso.NO_BIB_CONFIDENCE


def test_a_spectator_with_two_stray_reads_gets_no_number():
    from vision.pipeline import Sighting
    from vision.track import Tracker

    tracker = Tracker()
    box = (100, 100, 300, 700)
    for frame in range(200):
        if frame in (50, 120):
            sighting = Sighting("94", 0.95, box, box)
        else:
            sighting = Sighting(None, torso.NO_BIB_CONFIDENCE, None, box)
        tracker.add(frame, [sighting])
    assert all(r.text is None for r in tracker.flush())


def test_one_unsure_digit_refuses_the_whole_number():
    probs = _probs([BLANK, 4, 7])
    probs[2] = np.full(11, 0.05)
    probs[2, 7] = 0.5
    text, confidence = decode(probs)
    assert text is None and 0 < confidence < torso.MIN_CONFIDENCE


def test_a_gap_or_a_leading_zero_is_not_a_bib():
    assert decode(_probs([4, BLANK, 7]))[0] is None
    assert decode(_probs([BLANK, 0, 7]))[0] is None


def test_the_torso_band_sits_below_the_head():
    x1, y1, x2, y2 = torso_box((100, 200, 300, 700))
    assert (x1, x2) == (100, 300)
    assert y1 > 200 and y2 < 700


def test_without_a_model_every_person_reads_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(torso, "MODEL_PATH", tmp_path / "absent.onnx")
    image = Image.new("RGB", (400, 400))
    assert torso.read_torsos(image, [(0, 0, 200, 400)]) == [(None, 0.0)]


def _frame_with(monkeypatch, torso_read, block_read, bib_box):
    person = (100, 100, 300, 700)
    monkeypatch.setattr(pipeline, "detect_people", lambda image: [person])
    monkeypatch.setattr(pipeline, "read_torsos", lambda image, boxes: [torso_read])
    crop = Image.new("RGB", (60, 30))
    monkeypatch.setattr(pipeline, "extract_bib", lambda image, region=None: (bib_box, crop))
    monkeypatch.setattr(pipeline, "read_bib", lambda c: block_read)
    return pipeline.read_frame(Image.new("RGB", (800, 800)))[0]


def test_the_torso_reader_reads_a_bib_the_locator_missed(monkeypatch):
    sighting = _frame_with(monkeypatch, ("185", 0.97), (None, 0.0), None)
    assert sighting.text == "185"


def test_two_readers_that_disagree_refuse_the_person(monkeypatch):
    sighting = _frame_with(monkeypatch, ("185", 0.97), ("165", 0.95), (150, 300, 250, 350))
    assert sighting.text is None
    assert sighting.confidence > 0


def test_a_block_bigger_than_the_person_is_never_read(monkeypatch):
    # The whole-frame search took the finish arch for a bib: a block 1,368
    # pixels wide given to a runner 57 wide, read as 4.
    sighting = _frame_with(monkeypatch, (None, 0.0), ("4", 1.0), (0, 0, 780, 600))
    assert sighting.text is None


def test_a_bib_sized_block_still_reads_when_the_torso_reader_cannot(monkeypatch):
    sighting = _frame_with(monkeypatch, (None, 0.0), ("47", 0.99), (150, 300, 250, 350))
    assert sighting.text == "47"
