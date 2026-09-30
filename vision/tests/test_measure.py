from vision.measure import score


def test_all_correct_is_full_read_rate():
    report = score(expected=["1", "2", "3"], got=["1", "2", "3"])
    assert report.read_rate == 1.0
    assert report.wrong_rate == 0.0


def test_a_missed_runner_lowers_read_rate_but_is_not_a_wrong_read():
    report = score(expected=["1", "2", "3"], got=["1", "2"])
    assert report.read_rate == 2 / 3
    assert report.wrong_rate == 0.0
    assert report.missed == ["3"]


def test_a_wrong_number_counts_as_wrong_not_merely_missed():
    # The dangerous failure: a runner is given somebody else's number.
    report = score(expected=["47"], got=["41"])
    assert report.read_rate == 0.0
    assert report.wrong_rate == 1.0
    assert report.wrong == ["41"]


def test_a_number_nobody_was_wearing_is_spurious():
    report = score(expected=["1"], got=["1", "999"])
    assert report.spurious == ["999"]
    assert report.read_rate == 1.0


def test_an_inserted_digit_is_a_wrong_read_not_a_spurious_one():
    # A bright strap across bib 47 reads as 147. The runner is given a
    # number that is not theirs. Filing that as "spurious" makes the gate
    # metric blind to the misreads this pipeline actually makes.
    report = score(expected=["47"], got=["147"])
    assert report.wrong == ["147"]
    assert report.wrong_rate == 1.0


def test_a_dropped_digit_is_a_wrong_read():
    report = score(expected=["1047"], got=["104"])
    assert report.wrong == ["104"]
    assert report.wrong_rate == 1.0


def test_a_neighbours_number_is_a_wrong_read():
    # Runner A is handed runner B's bib. Two digits differ, so an
    # edit-distance-1 test alone does not catch it, but A is still wrong.
    report = score(expected=["47", "83"], got=["83", "83"])
    assert report.wrong_rate > 0.0
    assert "83" in report.wrong


def test_a_number_nobody_wore_and_nobody_missed_is_still_reported():
    report = score(expected=["1"], got=["1", "999"])
    assert report.spurious == ["999"]


def test_a_corrupt_frame_is_skipped_rather_than_killing_the_run(tmp_path):
    # queue.write never fsyncs, so a power cut at the gate can land the
    # rename before the data. One torn frame out of two thousand must not
    # lose the whole measurement.
    from vision.measure import load_frame

    good = tmp_path / "good.jpg"
    from PIL import Image
    Image.new("RGB", (32, 32), (10, 20, 30)).save(good)
    torn = tmp_path / "torn.jpg"
    torn.write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")

    assert load_frame(good) is not None
    assert load_frame(torn) is None


def test_per_track_rows_expose_the_numbers_the_confidence_floor_needs():
    # The spec says the staged shoot produces the confidence floor. Aggregate
    # rates cannot yield it; the floor is read off per-track confidence
    # against whether that track was right.
    from vision.measure import per_track_rows

    class Track:
        def __init__(self, text, confidence, frame_count):
            self.text, self.confidence, self.frame_count = text, confidence, frame_count

    rows = per_track_rows(
        [Track("47", 0.99, 30), Track("83", 0.41, 2), Track(None, 0.0, 5)],
        expected=["47"],
    )
    assert [r.verdict for r in rows] == ["correct", "wrong", "unreadable"]
    assert rows[0].confidence == 0.99
    assert rows[1].frame_count == 2
