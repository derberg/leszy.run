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
