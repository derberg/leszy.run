from vision.pipeline import Sighting
from vision.track import IOU_MATCH, Tracker, iou


def sighting(text, confidence, box):
    return Sighting(text, confidence, box, box)


def test_one_runner_across_frames_becomes_one_result():
    tracker = Tracker()
    for i in range(10):
        tracker.add(i, [sighting("47", 0.9, (100 + i * 5, 200, 200 + i * 5, 260))])
    results = tracker.results()
    assert len(results) == 1
    assert results[0].text == "47"
    assert results[0].frame_count == 10


def test_a_minority_of_wrong_reads_is_outvoted():
    tracker = Tracker()
    for i, text in enumerate(["47"] * 8 + ["41", "17"]):
        tracker.add(i, [sighting(text, 0.9, (100 + i * 5, 200, 200 + i * 5, 260))])
    assert tracker.results()[0].text == "47"


def test_the_overlap_fixture_is_actually_adversarial():
    # Guard the test below. Its first version used boxes whose overlap was
    # 0.113 against a match threshold of 0.3, so cross-matching was
    # arithmetically impossible and the test passed by construction while
    # testing nothing.
    a = (100, 200, 250, 320)
    b = (130, 205, 280, 325)
    assert iou(a, b) > IOU_MATCH


def test_two_overlapping_runners_stay_two_tracks():
    # The boxes overlap enough that the tracker could confuse them, and each
    # moves consistently. A merged track would give one result, and a number
    # built from both would belong to neither runner.
    tracker = Tracker()
    for i in range(8):
        tracker.add(i, [
            sighting("47", 0.9, (100 + i * 6, 200, 250 + i * 6, 320)),
            sighting("83", 0.9, (130 + i * 6, 205, 280 + i * 6, 325)),
        ])
    assert sorted(r.text for r in tracker.results()) == ["47", "83"]


def test_unreadable_track_survives_with_no_text():
    tracker = Tracker()
    for i in range(6):
        tracker.add(i, [sighting(None, 0.0, (100 + i * 5, 200, 200 + i * 5, 260))])
    results = tracker.results()
    assert len(results) == 1
    assert results[0].text is None
    assert results[0].frame_count == 6
