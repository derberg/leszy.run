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
import shutil
import time
from pathlib import Path

from PIL import Image

from vision.clock import clock_synced
from vision.queue import FrameQueue

DEFAULT_EXPOSURE_US = 1200
# A native sensor mode of the Camera Module 3 (IMX708), so the frame is
# binned rather than cropped and keeps the full 75 degree field of view.
DEFAULT_SIZE = (2304, 1296)
# The runner is read 2 to 3 m from the lens. Autofocus would hunt as people
# cross the frame, so the lens is held at this distance instead.
DEFAULT_FOCUS_M = 3.0


class ClockNotSynced(RuntimeError):
    pass


DEFAULT_GAIN = 4.0
# Middle grey for the centre of the frame, where the runner is.
DEFAULT_TARGET_LUMINANCE = 0.4
# A runner at 5 m/s moves 15 mm in 3 ms, a fifth of a 76 mm digit. Longer
# than that and the digits smear into each other.
DEFAULT_MAX_EXPOSURE_US = 3000
MIN_EXPOSURE_US = 100
# The reader manages about 8 frames a second on a Pi 5. At its natural 13 fps
# the camera outran it for the whole session and the audit view fell minutes
# behind. A runner coming down the lane is still in about ten frames at 6.
DEFAULT_FPS = 6.0


def build_controls(exposure_us=DEFAULT_EXPOSURE_US, gain=DEFAULT_GAIN,
                   fps=None, focus_m=None) -> dict:
    """Camera controls that actually pin the shutter.

    AeEnable must be False. With auto exposure on, the AE algorithm owns both
    shutter and gain and a manual ExposureTime beside it is overridden, which
    would put motion blur straight back into the frames in exactly the low
    light the fast shutter was chosen for.

    The cost is that libcamera no longer adapts exposure, so run_capture
    does it instead, through next_exposure, with the shutter kept short.
    """
    controls = {
        "AeEnable": False,
        "ExposureTime": int(exposure_us),
        "AnalogueGain": float(gain),
    }
    if fps:
        # Equal bounds pin the frame duration, and with it the frame rate.
        frame_us = int(1_000_000 / fps)
        controls["FrameDurationLimits"] = (frame_us, frame_us)
    if focus_m:
        # AfMode 0 is libcamera's AfModeManual. LensPosition is in dioptres.
        controls["AfMode"] = 0
        controls["LensPosition"] = 1.0 / focus_m
    return controls


def supported(controls: dict, available) -> dict:
    """The controls this camera has. A Camera Module 2 has no lens motor."""
    return {k: v for k, v in controls.items() if k in available}


def open_camera(size=DEFAULT_SIZE, exposure_us=DEFAULT_EXPOSURE_US,
                gain=DEFAULT_GAIN, fps=DEFAULT_FPS, focus_m=DEFAULT_FOCUS_M):
    """Configure picamera2 with one mode, a locked shutter and a fixed lens."""
    from picamera2 import Picamera2

    camera = Picamera2()
    controls = build_controls(exposure_us, gain, fps, focus_m)
    config = camera.create_video_configuration(
        main={"size": size, "format": "RGB888"},
        controls=supported(controls, camera.camera_controls),
    )
    camera.configure(config)
    return camera


# A healthy camera delivers a frame every 70 ms or so. Five seconds without
# one means the pipeline is wedged: on the Pi a capture killed mid-stream left
# the driver failing every buffer, and the next run blocked in capture_request
# forever while systemd showed it running. Failing instead lets systemd see it.
FRAME_TIMEOUT_S = 5.0


class CameraStalled(RuntimeError):
    """The camera stopped delivering frames."""


def to_image(array) -> Image.Image:
    """The camera's BGR array as an RGB image.

    Reversing the channels with array[:, :, ::-1] gives the same pixels, but
    as a strided view that PIL copies pixel by pixel: 16 ms a frame on a
    laptop, and on the Pi enough that capture alone took more than a whole
    core at 13 fps, starving the reader. cvtColor does it in under 1 ms.
    """
    import cv2

    return Image.fromarray(cv2.cvtColor(array, cv2.COLOR_BGR2RGB))


def next_exposure(luminance, gain, exposure_us, *, target, base_us, max_us,
                  min_us, max_gain, dead_band=0.15):
    """The (gain, exposure in us) that moves the frame towards target.

    Gain is spent before shutter, because a longer shutter blurs a runner and
    gain only adds noise. The shutter stays at base_us until gain is at its
    ceiling, then lengthens to max_us and no further. In bright light it
    drops below base_us only once gain is down to 1. One step at most doubles
    or halves the exposure, and a frame within dead_band of the target is
    left alone, so the loop does not chase sensor noise.
    """
    luminance = max(luminance, 1e-3)
    if abs(luminance - target) <= dead_band * target:
        return gain, exposure_us
    total = gain * exposure_us * min(2.0, max(0.5, target / luminance))
    if total <= base_us:
        return 1.0, int(round(max(min_us, total)))
    if total <= max_gain * base_us:
        return total / base_us, base_us
    return max_gain, int(round(min(max_us, total / max_gain)))


def centre_luminance(array) -> float:
    """Mean brightness of the middle of the frame, 0 to 1.

    The middle, because that is where the runner is. A bright window or sky
    at the edge would otherwise hold the exposure down while the bib stays
    dark. Every eighth pixel is plenty for a mean.
    """
    h, w = array.shape[:2]
    return float(array[h // 5:h * 4 // 5:8, w // 5:w * 4 // 5:8].mean()) / 255.0


def has_room(directory, min_free_bytes: int) -> bool:
    """True while the queue's filesystem keeps min_free_bytes free.

    Capture writes several megabytes a second and nothing deletes frames
    until the retention purge. Run as a boot service it would otherwise fill
    the disk, and on a Pi with no SSD that is the SD card the database lives
    on, so a full card takes timing down with it.
    """
    return shutil.disk_usage(directory).free >= min_free_bytes


def run_capture(queue_dir, duration_s: float, size=DEFAULT_SIZE,
                exposure_us=DEFAULT_EXPOSURE_US, gain=DEFAULT_GAIN,
                allow_unsynced_clock=False, min_free_bytes=0,
                fps=DEFAULT_FPS, focus_m=DEFAULT_FOCUS_M, auto_exposure=True,
                target_luminance=DEFAULT_TARGET_LUMINANCE,
                max_exposure_us=DEFAULT_MAX_EXPOSURE_US):
    """Capture for duration_s seconds into queue_dir. Returns frames written.

    With auto_exposure, gain and exposure_us are only the starting point.
    """
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
    camera = open_camera(size=size, exposure_us=exposure_us, gain=gain,
                         fps=fps, focus_m=focus_m)
    camera.start()
    gain_range = getattr(camera, "camera_controls", {}).get("AnalogueGain")
    max_gain = float(gain_range[1]) if gain_range else 16.0
    adjust_every = max(1, int(round(fps or 1)))    # about once a second

    def report():
        queue.write_exposure(gain, exposure_us,
                             gain >= max_gain and exposure_us >= max_exposure_us)

    report()

    # One offset for the whole session, so every frame converts the same way.
    offset = time.time() - time.monotonic()
    queue.write_session(offset)
    written = 0
    try:
        deadline = time.monotonic() + duration_s
        while time.monotonic() < deadline:
            # Checked every 30 frames, about two seconds: often enough to
            # stop well before the margin is gone, rare enough to cost nothing.
            if written % 30 == 0 and not has_room(queue.dir, min_free_bytes):
                print(f"stopping: less than {min_free_bytes / 1e9:.1f} GB "
                      f"free under {queue.dir}")
                break
            try:
                request = camera.capture_request(wait=FRAME_TIMEOUT_S)
            except TimeoutError as err:
                raise CameraStalled(
                    f"no frame from the camera in {FRAME_TIMEOUT_S:.0f} s"
                ) from err
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
            queue.write(to_image(array), sensor_ns)
            written += 1
            if auto_exposure and written % adjust_every == 0:
                new_gain, new_exposure = next_exposure(
                    centre_luminance(array), gain, exposure_us,
                    target=target_luminance, base_us=DEFAULT_EXPOSURE_US,
                    max_us=max_exposure_us, min_us=MIN_EXPOSURE_US,
                    max_gain=max_gain,
                )
                if (new_gain, new_exposure) != (gain, exposure_us):
                    gain, exposure_us = new_gain, new_exposure
                    camera.set_controls(
                        {"AnalogueGain": gain, "ExposureTime": exposure_us})
                    report()
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
