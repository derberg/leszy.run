from collections import namedtuple

import vision.capture as capture

Usage = namedtuple("Usage", "total used free")


def test_room_while_free_space_is_above_the_margin(tmp_path, monkeypatch):
    monkeypatch.setattr(capture.shutil, "disk_usage",
                        lambda _: Usage(100, 10, 6_000_000_000))
    assert capture.has_room(tmp_path, 5_000_000_000)


def test_no_room_once_free_space_drops_below_the_margin(tmp_path, monkeypatch):
    # A boot service with no limit fills the SD card the database lives on.
    monkeypatch.setattr(capture.shutil, "disk_usage",
                        lambda _: Usage(100, 96, 4_000_000_000))
    assert not capture.has_room(tmp_path, 5_000_000_000)


class _WedgedCamera:
    def start(self): pass
    def stop(self): pass
    def close(self): pass

    def capture_request(self, wait=None):
        raise TimeoutError


def test_a_wedged_camera_fails_instead_of_hanging(tmp_path, monkeypatch):
    # Hanging kept systemd reporting a running service that wrote nothing.
    import pytest
    monkeypatch.setattr(capture, "clock_synced", lambda: True)
    monkeypatch.setattr(capture, "open_camera", lambda **_: _WedgedCamera())
    with pytest.raises(capture.CameraStalled):
        capture.run_capture(tmp_path, 60)


def test_frame_rate_is_pinned_by_the_frame_duration():
    # The reader manages about 8 frames a second on a Pi 5. A camera left at
    # its natural 13 fps outruns it for the whole race and the view falls
    # minutes behind.
    controls = capture.build_controls(exposure_us=1200, gain=4.0, fps=6)
    assert controls["FrameDurationLimits"] == (166_666, 166_666)
    assert controls["ExposureTime"] == 1200


def test_no_frame_rate_leaves_the_camera_at_its_own_pace():
    assert "FrameDurationLimits" not in capture.build_controls(1200, 4.0)


def test_the_camera_array_becomes_an_rgb_image_with_channels_swapped():
    # picamera2's "RGB888" is BGR in memory. The swap has to give the same
    # image as before, only without PIL copying a reversed view pixel by pixel.
    import numpy as np
    bgr = np.zeros((4, 6, 3), dtype=np.uint8)
    bgr[..., 0], bgr[..., 1], bgr[..., 2] = 10, 20, 30
    image = capture.to_image(bgr)
    assert image.mode == "RGB"
    assert image.size == (6, 4)
    assert image.getpixel((0, 0)) == (30, 20, 10)
