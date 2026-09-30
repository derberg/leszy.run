import pytest

from vision.clock import check_ordering, monotonic_to_utc


def test_monotonic_timestamps_report_no_anomaly():
    assert check_ordering([100, 200, 300, 400]) == []


def test_a_backwards_jump_is_reported_with_its_index():
    # The clock stepped back between frames 2 and 3. Ordering must stay
    # stable and the anomaly must surface, not be silently sorted away.
    assert check_ordering([100, 200, 150, 400]) == [2]


def test_repeated_timestamps_are_not_an_anomaly():
    assert check_ordering([100, 100, 200]) == []


def test_monotonic_converts_with_the_captured_offset():
    converted = monotonic_to_utc(5_000_000_000, offset=1_700_000_000.0)
    assert converted.timestamp() == pytest.approx(1_700_000_005.0, abs=0.001)


def test_exposure_controls_lock_the_shutter_rather_than_asking_ae_to():
    # With AeEnable true the auto-exposure algorithm owns both shutter and
    # gain, so a manual ExposureTime beside it is overridden. The whole
    # motion-blur argument rests on the shutter actually being locked.
    from vision.capture import build_controls

    controls = build_controls(exposure_us=1200, gain=4.0)
    assert controls["AeEnable"] is False
    assert controls["ExposureTime"] == 1200
    assert controls["AnalogueGain"] == 4.0
