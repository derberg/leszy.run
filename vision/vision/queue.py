"""A directory of frames that capture writes and the reader drains.

The queue is what makes a slow reader harmless. Without it, a reader that
falls behind drops frames for good. With it, a reader that falls behind is
only late, and it catches up between finishers.

Every write goes to a .part file and is renamed into place, so a reader never
meets a half-written frame even when capture is killed mid-write. Frames are
named by sensor timestamp, zero padded, so sorting the directory sorts by
time.
"""
from pathlib import Path

NAME_WIDTH = 18          # nanoseconds since boot fits well inside this
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
