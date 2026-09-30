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
