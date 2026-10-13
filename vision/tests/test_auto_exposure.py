import pytest

from vision.capture import next_exposure

LIMITS = dict(target=0.4, base_us=1200, max_us=3000, min_us=300, max_gain=16.0)


def test_a_dark_frame_raises_gain_and_keeps_the_fast_shutter():
    gain, exposure = next_exposure(0.1, 4.0, 1200, **LIMITS)
    assert exposure == 1200
    assert gain == pytest.approx(8.0)    # one step is at most a doubling


def test_the_shutter_lengthens_only_once_gain_is_at_its_ceiling():
    gain, exposure = next_exposure(0.1, 16.0, 1200, **LIMITS)
    assert gain == 16.0
    assert exposure == 2400


def test_the_shutter_never_passes_its_cap():
    # A longer shutter blurs a runner. Past the cap a dark frame stays dark.
    assert next_exposure(0.02, 16.0, 3000, **LIMITS) == (16.0, 3000)


def test_a_bright_frame_shortens_the_shutter_before_gain_drops():
    gain, exposure = next_exposure(0.8, 16.0, 2400, **LIMITS)
    assert gain == 16.0
    assert exposure == 1200


def test_at_unity_gain_a_bright_frame_shortens_below_the_base():
    gain, exposure = next_exposure(0.8, 1.0, 1200, **LIMITS)
    assert gain == 1.0
    assert exposure == 600


def test_a_frame_near_the_target_changes_nothing():
    # Without a dead band the loop would chase sensor noise every second.
    assert next_exposure(0.43, 6.0, 1200, **LIMITS) == (6.0, 1200)


def test_the_runner_in_the_middle_decides_not_the_window_at_the_edge():
    import numpy as np
    from vision.capture import centre_luminance

    frame = np.full((100, 100, 3), 20, dtype=np.uint8)
    frame[:, :15] = 255                     # a bright window down one side
    assert centre_luminance(frame) == pytest.approx(20 / 255)
