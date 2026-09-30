"""A directory of frames that capture writes and the reader drains.

The queue is what makes a slow reader harmless. Without it, a reader that
falls behind drops frames for good. With it, a reader that falls behind is
only late, and it catches up between finishers.

Every write goes to a .part file and is renamed into place, so a reader never
meets a half-written frame even when capture is killed mid-write. Frames are
named by sensor timestamp, zero padded, so sorting the directory sorts by
time.
"""
import json
from pathlib import Path

# Epoch nanoseconds need 19 digits and nanoseconds since boot need fewer.
# Pad to 20 so every name is the same length, because a mix of widths sorts
# lexically wrong and these names are sorted to order frames by time.
NAME_WIDTH = 20
SUFFIX = ".jpg"
JPEG_QUALITY = 88


class FrameQueue:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.done = self.dir / "done"
        self.done.mkdir(exist_ok=True)

    def write(self, image, sensor_timestamp_ns: int) -> Path:
        name = f"{sensor_timestamp_ns:0{NAME_WIDTH}d}{SUFFIX}"
        partial = self.dir / (name + ".part")
        final = self.dir / name
        image.save(partial, format="JPEG", quality=JPEG_QUALITY)
        partial.replace(final)      # atomic within one filesystem
        return final

    def pending(self) -> list:
        """Unread frames, oldest first. A .part file is not one of them."""
        return sorted(p for p in self.dir.glob(f"*{SUFFIX}") if p.is_file())

    def mark_done(self, path) -> None:
        Path(path).replace(self.done / Path(path).name)

    def timestamp_of(self, path) -> int:
        return int(Path(path).stem)

    def ordering_anomalies(self) -> list:
        """Timestamps that are earlier than the frame written before them.

        pending() sorts, which puts the frames back in numeric order and
        hides the fact that the sensor clock stepped backwards. Frames on
        either side of such a step cannot be compared, so the step is
        reported rather than quietly smoothed over.
        """
        from vision.clock import check_ordering

        written = sorted(
            (p for p in self.dir.glob(f"*{SUFFIX}")),
            key=lambda p: p.stat().st_mtime_ns,
        )
        stamps = [self.timestamp_of(p) for p in written]
        return [stamps[i] for i in check_ordering(stamps)]

    def write_session(self, offset: float) -> None:
        """Record the monotonic-to-UTC offset for this capture session.

        Without it the frames carry sensor nanoseconds and nothing else, so
        once capture exits no frame can be tied to a wall clock, and a gun
        time cannot be matched to a crossing.
        """
        (self.dir / "session.json").write_text(json.dumps({"offset": offset}))

    def session_offset(self):
        path = self.dir / "session.json"
        if not path.exists():
            return None
        try:
            return float(json.loads(path.read_text())["offset"])
        except (ValueError, KeyError):
            return None
