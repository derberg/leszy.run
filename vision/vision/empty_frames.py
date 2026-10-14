"""Delete the frames that are proven to show nobody.

Capture writes several frames a second whether or not anybody is in them,
and the SD card that holds them also holds the database.

Only a frame the reader read and found no person in is a candidate, and even
then it is kept while a person was seen within MAX_GAP_FRAMES of it, because
the tracker joins a runner across that many missed frames and those frames
are part of the pass. A candidate goes into a ledger on disk, and a sweep
deletes ledger entries whose file is older than the keep window. Frames that
were never judged, because the reader skipped them for lag or could not
decode them, never enter the ledger and are never deleted here.

Age is the file's mtime, which is the wall clock when capture wrote it. The
name holds the sensor clock, which counts from boot and says nothing about
how long ago a frame was taken.

This module deletes files in done/ and touches nothing else. The 30-day
retention purge in the backend still removes whatever is left.
"""
import os
import re
import time
from collections import deque
from pathlib import Path

from vision.track import MAX_GAP_FRAMES

LEDGER_NAME = "empty_frames.txt"
# A ledger line is followed only when it is a bare frame name, so a damaged
# line can never point the sweep at another file.
FRAME_NAME = re.compile(r"^\d{1,20}\.jpg$")


class EmptyFrameSweeper:
    def __init__(self, queue_dir, keep_s, gap_frames=MAX_GAP_FRAMES, clock=time.time):
        self.dir = Path(queue_dir)
        self.done = self.dir / "done"
        self.ledger = self.dir / LEDGER_NAME
        self.keep_s = float(keep_s)
        self.gap = int(gap_frames)
        self.clock = clock
        self.candidates = deque()   # (frame index, name), oldest first
        self.last_person = None
        self.deleted = 0
        self.deleted_bytes = 0

    def observe(self, index, name, had_people):
        """Record what the reader found in one frame, in frame order.

        A frame with a person is never recorded. An empty frame waits in
        memory until MAX_GAP_FRAMES later frames have been seen, because a
        person in any of them would make it part of that runner's pass.
        """
        if had_people:
            self.last_person = index
            while self.candidates and self.candidates[-1][0] >= index - self.gap:
                self.candidates.pop()
        elif self.last_person is None or index - self.last_person > self.gap:
            self.candidates.append((index, name))

        settled = []
        while self.candidates and self.candidates[0][0] <= index - self.gap:
            settled.append(self.candidates.popleft()[1])
        if settled:
            self._append(settled)

    def _append(self, names):
        data = "".join(n + "\n" for n in names).encode("ascii")
        fd = os.open(self.ledger, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)

    def sweep(self):
        """Delete ledger frames older than the keep window.

        Files go first and the ledger is rewritten after. A crash in between
        leaves names whose file is already gone, which the next sweep drops.
        The ledger only ever names frames judged empty, so no crash can lead
        to deleting a frame that was kept for a reason.
        """
        try:
            lines = self.ledger.read_text(encoding="ascii", errors="replace").splitlines()
        except FileNotFoundError:
            return
        now = self.clock()
        remaining = []
        for name in lines:
            if not FRAME_NAME.match(name):
                continue
            path = self.done / name
            try:
                info = path.stat()
            except FileNotFoundError:
                continue
            if now - info.st_mtime < self.keep_s:
                remaining.append(name)
                continue
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            self.deleted += 1
            self.deleted_bytes += info.st_size

        part = self.ledger.with_suffix(".txt.part")
        part.write_text("".join(n + "\n" for n in remaining), encoding="ascii")
        part.replace(self.ledger)
