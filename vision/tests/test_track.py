from vision.pipeline import Sighting
from vision.track import IOU_MATCH, MAX_GAP_FRAMES, Tracker, iou


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


# ─── streaming: closing a track while the race is still running ─────────────
# The audit screen shows runners as they pass, so a track has to be emitted
# the moment it can no longer change, not at the end of the session.

def test_a_track_closes_once_it_can_no_longer_gain_a_sighting():
    tracker = Tracker()
    for i in range(5):
        tracker.add(i, [sighting("47", 0.9, (100, 200, 200, 260))])
    assert tracker.pop_closed(5) == []          # still live, could still match
    closed = tracker.pop_closed(5 + MAX_GAP_FRAMES + 1)
    assert len(closed) == 1
    assert closed[0].text == "47"


def test_a_closed_track_is_not_emitted_a_second_time():
    # Emitting twice would put one runner on the screen as two crossings.
    tracker = Tracker()
    tracker.add(0, [sighting("47", 0.9, (100, 200, 200, 260))])
    assert len(tracker.pop_closed(100)) == 1
    assert tracker.pop_closed(200) == []


def test_closing_one_track_leaves_a_live_one_alone():
    tracker = Tracker()
    tracker.add(0, [sighting("47", 0.9, (100, 200, 200, 260))])
    tracker.add(20, [sighting("86", 0.9, (600, 200, 700, 260))])
    closed = tracker.pop_closed(21)
    assert [t.text for t in closed] == ["47"]
    assert [t.text for t in tracker.results()] == ["86"]


def test_flush_emits_whatever_is_still_open_at_shutdown():
    # The last runner of the day must not be lost because nobody followed.
    tracker = Tracker()
    tracker.add(0, [sighting("47", 0.9, (100, 200, 200, 260))])
    assert [t.text for t in tracker.flush()] == ["47"]
    assert tracker.flush() == []


def test_a_track_remembers_which_box_its_best_read_came_from():
    # The audit screen shows the bib crop beside the number. Without the box
    # of the winning read there is no way to know which of several people in
    # that frame the crop should come from, and the screen would illustrate
    # one runner's number with another runner's bib.
    tracker = Tracker()
    tracker.add(0, [Sighting("47", 0.4, (10, 20, 30, 40), (0, 0, 100, 300))])
    tracker.add(1, [Sighting("47", 0.95, (11, 21, 31, 41), (0, 0, 100, 300))])
    result = tracker.results()[0]
    assert result.best_frame_index == 1
    assert result.best_bib_box == (11, 21, 31, 41)
