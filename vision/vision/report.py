"""What a capture session tells an operator about itself.

This module exists so the audit screen can answer one question on race
morning: is the camera connected, pointed right, exposed right, and reading
numbers? Every function here is pure over plain data, because a wrong answer
on that screen sends somebody to fix the wrong thing.

Nothing here opens a socket or touches a database. The session writes files;
the Node backend on the same machine reads them. That is the whole transport,
and it is what keeps this package offline.
"""
import json
import os
from pathlib import Path

from PIL import ImageStat

from vision.clock import monotonic_to_utc

# A frame older than this means capture has stopped. Generous enough that a
# throttled reader or a brief stall does not cry wolf.
CAPTURE_DEAD_AFTER_S = 5.0

# Below and above these the operator has to change the gain by hand, because
# capture locks AeEnable to False and nothing adapts on its own.
DARK_BELOW = 0.08
BRIGHT_ABOVE = 0.92

# Luminance is sampled at this size. Brightness survives downsampling and a
# full frame is two megapixels.
LUMINANCE_SAMPLE_PX = 128

HISTOGRAM_BUCKETS = (
    ("1-4", 1, 4),
    ("5-9", 5, 9),
    ("10-24", 10, 24),
    ("25+", 25, None),
)


def sighting_record(result, frame_stamps: dict, offset: float) -> dict:
    """One closed track as the line that goes into the log.

    The timestamp comes from the frame where the runner was best seen, never
    from the clock at write time. The reader is allowed to fall behind by
    design, so write time would record when the computer caught up rather
    than when the runner crossed.
    """
    if result.best_frame_index < 0:
        raise ValueError(
            "track has no best frame, so it has no crossing moment. A "
            "fabricated timestamp in a record of what happened is worse "
            "than no record."
        )
    stamp = frame_stamps.get(result.best_frame_index)
    if stamp is None:
        raise ValueError(
            f"no sensor timestamp known for frame {result.best_frame_index}"
        )
    return {
        "bib_number": result.text,
        "confidence": round(float(result.confidence), 4),
        "frame_count": int(result.frame_count),
        "best_frame_ts": int(stamp),
        "sighted_at": monotonic_to_utc(stamp, offset).isoformat(),
        "votes": {k: round(float(v), 4) for k, v in result.votes.items()},
    }


class SightingLog:
    """An append-only JSONL file the backend tails.

    One sighting is one line. A reader that arrives mid-write sees a line
    without its newline and must wait, which is why nothing is ever written
    containing a newline of its own: a stray one would split a sighting into
    two, and the second half would parse as a crossing with no bib.
    """

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: dict) -> None:
        # ensure_ascii keeps every character inside one byte, so the line
        # stays short enough for the append to land in one piece.
        line = json.dumps(record, ensure_ascii=True).replace("\n", " ") + "\n"
        # O_APPEND so two writers could never interleave, and one write call
        # so a reader never meets half a line.
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line.encode("ascii"))
        finally:
            os.close(fd)


def mean_luminance(image) -> float:
    """Average brightness from 0 to 1.

    Normalised so a threshold means the same thing whatever the image depth,
    and so the number on the screen is comparable between races.
    """
    if image.width == 0 or image.height == 0:
        return 0.0
    # A full frame is two megapixels and this runs on every heartbeat, so
    # sample rather than read every pixel. Brightness survives downsampling.
    grey = image.convert("L")
    if max(grey.size) > LUMINANCE_SAMPLE_PX:
        grey.thumbnail((LUMINANCE_SAMPLE_PX, LUMINANCE_SAMPLE_PX))
    return ImageStat.Stat(grey).mean[0] / 255.0


def health_snapshot(*, pending: int, processed: int, ms_per_frame: float,
                    capture_fps: float, clock_synced, ordering_anomalies: list,
                    torn_frames: int, mean_luminance: float,
                    last_frame_age_s: float) -> dict:
    """Everything the health strip shows, decided here rather than in React.

    The thresholds live in Python next to the code that produces the inputs,
    so a change to one is visible beside the other.
    """
    reader_fps = 1000.0 / ms_per_frame if ms_per_frame > 0 else 0.0
    exposure = "ok"
    if mean_luminance < DARK_BELOW:
        exposure = "dark"
    elif mean_luminance > BRIGHT_ABOVE:
        exposure = "bright"
    return {
        "capture_alive": last_frame_age_s <= CAPTURE_DEAD_AFTER_S,
        "last_frame_age_s": round(float(last_frame_age_s), 2),
        "pending": int(pending),
        "processed": int(processed),
        "ms_per_frame": round(float(ms_per_frame), 1),
        "reader_fps": round(reader_fps, 2),
        "capture_fps": round(float(capture_fps), 2),
        # A reader slower than capture does not merely lag, it loses ground
        # for as long as the race lasts.
        "keeping_up": reader_fps >= capture_fps,
        "clock_synced": clock_synced,
        "ordering_anomalies": list(ordering_anomalies),
        "torn_frames": int(torn_frames),
        "mean_luminance": round(float(mean_luminance), 3),
        "exposure": exposure,
    }


def recognition_rate(tracks) -> float:
    """Tracks that produced a number, over every track seen.

    Deliberately NOT called read rate. Read rate is measured against the
    numbers people were actually wearing, and nothing here knows those. An
    unmeasured number wearing a measured number's name is how a threshold
    gets set from an assumption.

    Unreadable tracks stay in the denominator. Dropping them would report a
    camera reading one runner in ten as perfect.
    """
    if not tracks:
        return 0.0
    read = sum(1 for t in tracks if t.text is not None)
    return read / len(tracks)


def frames_per_track_histogram(tracks) -> dict:
    """How many frames each runner was seen in.

    This is the geometry argument as a number. A camera pointed down the lane
    gives a runner thirty-odd frames and one bad frame gets outvoted. Pointed
    across the lane it gives four, and four cannot outvote a bad one. A
    cluster in the low bucket means move the camera, not retrain the model.
    """
    hist = {label: 0 for label, _, _ in HISTOGRAM_BUCKETS}
    for track in tracks:
        count = track.frame_count
        for label, low, high in HISTOGRAM_BUCKETS:
            if count >= low and (high is None or count <= high):
                hist[label] += 1
                break
    return hist
