"""Capture frames from the Pi camera into the queue.

This process does one job and nothing else. It never reads a frame, never
runs a model, never touches a database. A stall here loses a runner for good,
so everything clever happens in the reader, which is allowed to fall behind.

Two camera settings carry the whole design:

ExposureTime is locked. At the real digit height of 76 mm, a runner at 25 km/h
smears about 3 px at 1/1000 s and about 6 px at 1/500 s, against a digit
around 50 px tall. Both are negligible. Gain noise is not, so the shutter is a
floor to relax in poor light rather than a constant.

The configuration never switches mode. picamera2 can switch to a still mode
for a higher resolution capture, and that switch costs hundreds of
milliseconds, by which time the runner has gone.
"""
import time
from pathlib import Path

from PIL import Image

from vision.clock import clock_synced
from vision.queue import FrameQueue

DEFAULT_EXPOSURE_US = 1200
DEFAULT_SIZE = (1640, 1232)


class ClockNotSynced(RuntimeError):
    pass


DEFAULT_GAIN = 4.0


def build_controls(exposure_us=DEFAULT_EXPOSURE_US, gain=DEFAULT_GAIN) -> dict:
    """Camera controls that actually pin the shutter.

    AeEnable must be False. With auto exposure on, the AE algorithm owns both
    shutter and gain and a manual ExposureTime beside it is overridden, which
    would put motion blur straight back into the frames in exactly the low
    light the fast shutter was chosen for.

    The cost is that gain no longer adapts by itself. Automatic gain
    adaptation is NOT implemented. Set `gain` for the conditions on the day,
    check a test capture, and adjust. Verifying this against the real camera
    is on the Task 13 hardware checklist.
    """
    return {
        "AeEnable": False,
        "ExposureTime": int(exposure_us),
        "AnalogueGain": float(gain),
    }


def open_camera(size=DEFAULT_SIZE, exposure_us=DEFAULT_EXPOSURE_US,
                gain=DEFAULT_GAIN):
    """Configure picamera2 with one mode and a locked shutter."""
    from picamera2 import Picamera2

    camera = Picamera2()
    config = camera.create_video_configuration(
        main={"size": size, "format": "RGB888"},
        controls=build_controls(exposure_us, gain),
    )
    camera.configure(config)
    return camera


def run_capture(queue_dir, duration_s: float, size=DEFAULT_SIZE,
                exposure_us=DEFAULT_EXPOSURE_US, gain=DEFAULT_GAIN,
                allow_unsynced_clock=False):
    """Capture for duration_s seconds into queue_dir. Returns frames written."""
    synced = clock_synced()
    if synced is False and not allow_unsynced_clock:
        raise ClockNotSynced(
            "System clock is not NTP synchronized. A 1970 timestamp in a race "
            "record is worse than no record. Fix the clock, or pass "
            "allow_unsynced_clock=True if you are only testing the camera."
        )
    if synced is None:
        print("warning: cannot determine clock sync (no timedatectl)")

    queue = FrameQueue(Path(queue_dir))
    camera = open_camera(size=size, exposure_us=exposure_us, gain=gain)
    camera.start()

    # One offset for the whole session, so every frame converts the same way.
    offset = time.time() - time.monotonic()
    queue.write_session(offset)
    written = 0
    try:
        deadline = time.monotonic() + duration_s
        while time.monotonic() < deadline:
            request = camera.capture_request()
            try:
                array = request.make_array("main")
                sensor_ns = request.get_metadata().get("SensorTimestamp")
            finally:
                request.release()
            if sensor_ns is None:
                # Without a sensor timestamp the frame cannot be ordered
                # against the others, and an unorderable frame is not
                # evidence. Drop it and say so.
                print("warning: frame had no SensorTimestamp, dropped")
                continue
            queue.write(Image.fromarray(array[:, :, ::-1]), sensor_ns)
            written += 1
    finally:
        camera.stop()
        camera.close()

    anomalies = queue.ordering_anomalies()
    if anomalies:
        print(f"WARNING: sensor clock stepped backwards at {anomalies}. "
              "Frames on either side of a step cannot be ordered against "
              "each other.")
    print(f"captured {written} frames, monotonic-to-utc offset {offset:.6f}")
    return written
