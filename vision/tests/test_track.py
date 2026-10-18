import pytest

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
    tracker.add(1, [sighting("47", 0.9, (100, 200, 200, 260))])
    tracker.add(19, [sighting("86", 0.9, (600, 200, 700, 260))])
    tracker.add(20, [sighting("86", 0.9, (600, 200, 700, 260))])
    closed = tracker.pop_closed(21)
    assert [t.text for t in closed] == ["47"]
    assert [t.text for t in tracker.results()] == ["86"]


def test_flush_emits_whatever_is_still_open_at_shutdown():
    # The last runner of the day must not be lost because nobody followed.
    tracker = Tracker()
    tracker.add(0, [sighting("47", 0.9, (100, 200, 200, 260))])
    tracker.add(1, [sighting("47", 0.9, (100, 200, 200, 260))])
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


def test_a_number_read_in_one_frame_of_a_long_pass_is_withheld():
    # A green fragment beside the digits read as 2 once in 163 frames and was
    # shown as 2 at a vote share of 1.00. One frame is noise, not a reading.
    tracker = Tracker()
    for i in range(30):
        text = "2" if i == 7 else None
        tracker.add(i, [sighting(text, 0.9, (100 + i, 200, 200 + i, 260))])
    result = tracker.results()[0]
    assert result.text is None
    assert result.votes == {"2": 0.9}     # kept, so the audit still shows it


def test_a_number_read_in_two_frames_stands():
    tracker = Tracker()
    for i in range(10):
        # A frame with no number found carries confidence 0; a non-zero
        # confidence with no number is a refused read, which votes against.
        text, confidence = ("47", 0.9) if i in (3, 4) else (None, 0.0)
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    assert tracker.results()[0].text == "47"


def _pass(tracker, texts, start=0):
    from vision.pipeline import Sighting
    for i, text in enumerate(texts):
        tracker.add(start + i, [Sighting(text, 0.99, (10, 10, 30, 20), (0, 0, 100, 200))])


def test_two_bibs_one_after_the_other_in_one_track_are_two_passes():
    # Bib 33 then bib 55 shown without leaving the frame made one track, and
    # the vote reported 55 and lost 33.
    t = Tracker()
    _pass(t, ["33"] * 6 + [None] * 2 + ["55"] * 8)
    results = t.flush()
    assert [r.text for r in results] == ["33", "55"]
    assert sum(r.frame_count for r in results) == 16
    assert all(r.confidence == 1.0 for r in results)


def test_misreads_interleaved_in_a_pass_do_not_split_it():
    t = Tracker()
    _pass(t, ["20", "29", "20", "20", "29", "20", "20"])
    assert [r.text for r in t.flush()] == ["20"]


def test_a_piece_of_the_number_at_the_end_of_a_pass_does_not_split_it():
    # A 20 cut by the edge of the frame on the way out reads as 0.
    t = Tracker()
    _pass(t, ["20"] * 6 + ["0"] * 3)
    assert [r.text for r in t.flush()] == ["20"]


def test_a_number_outnumbered_by_refused_reads_of_the_same_patch_is_withheld():
    # A leafy patch of a runner's top, found as a 53x34 "bib", came back as
    # 24 at 0.83 in two frames and was refused at 0.44 to 0.67 in about
    # twenty more. Only the two accepted reads voted, so 24 was reported at
    # a share of 1.00. The refusals are evidence that it is not a number.
    tracker = Tracker()
    for i in range(60):
        if i in (5, 40):
            text, confidence = "24", 0.83
        elif i % 3 == 0:
            text, confidence = None, 0.55
        else:
            text, confidence = None, 0.0
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    result = tracker.results()[0]
    assert result.text is None
    assert result.votes == {"24": pytest.approx(1.66)}


def test_a_few_refused_reads_do_not_overturn_a_clear_number():
    tracker = Tracker()
    for i in range(12):
        if i in (2, 3, 4, 5, 6):
            text, confidence = "47", 0.95
        elif i in (7, 8):
            text, confidence = None, 0.6
        else:
            text, confidence = None, 0.0
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    assert tracker.results()[0].text == "47"


def test_one_certain_read_in_a_short_uncontested_pass_stands():
    # A runner crossing quickly gave ten frames, and only one held the bib
    # close enough to read: 7 at 1.00. Nothing else in the pass was read or
    # refused, so there is nothing for that read to be outvoted by.
    tracker = Tracker()
    for i in range(10):
        text, confidence = ("7", 1.0) if i == 2 else (None, 0.0)
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    result = tracker.results()[0]
    assert result.text == "7"
    assert result.confidence == 1.0


def test_one_certain_read_in_a_long_pass_is_still_withheld():
    # Someone lingering in front of the camera is where fragments get read.
    tracker = Tracker()
    for i in range(163):
        text, confidence = ("2", 1.0) if i == 7 else (None, 0.0)
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    assert tracker.results()[0].text is None


def test_one_read_is_withheld_when_the_pass_also_refused_a_read():
    tracker = Tracker()
    for i in range(10):
        if i == 2:
            text, confidence = "7", 1.0
        elif i == 3:
            text, confidence = None, 0.6
        else:
            text, confidence = None, 0.0
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    assert tracker.results()[0].text is None


def test_one_read_below_certainty_is_withheld_even_in_a_short_pass():
    tracker = Tracker()
    for i in range(10):
        text, confidence = ("7", 0.95) if i == 2 else (None, 0.0)
        tracker.add(i, [sighting(text, confidence, (100 + i, 200, 200 + i, 260))])
    assert tracker.results()[0].text is None


def test_a_runner_who_walks_through_a_spectators_track_keeps_the_number():
    # 2026-10-17: bib 188, read in 18 frames, joined a spectator's track of
    # nearly a hundred frames and was outvoted by the "no bib" frames the
    # spectator had made before she arrived.
    from vision.pipeline import Sighting
    tracker = Tracker()
    box = (1200, 840, 1270, 950)
    for frame in range(80):
        tracker.add(frame, [Sighting(None, 0.01, None, box)])
    for frame in range(80, 98):
        tracker.add(frame, [Sighting("188", 1.0, box, box)])
    assert [r.text for r in tracker.flush()] == ["188"]
