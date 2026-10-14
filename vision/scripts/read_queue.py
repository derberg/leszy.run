"""Drain the frame queue continuously and write what was seen.

This is the process the audit screen watches. It runs beside capture on the
Pi, reads frames as they land, and appends one line per runner to a log the
Node backend tails.

It writes files and nothing else. No socket, no database, no upload. That is
deliberate and it is the whole reason the data protection position holds: a
photograph never leaves this machine, and the only thing that crosses to the
backend is a number, a timestamp and a confidence.

It is throttled on purpose. The Pi 5 has no accelerator and cannot read every
frame in real time, so this view is diagnostic and the chip stays the timing
source. Falling behind is safe by construction: the queue keeps the frames.

Frames it read and found nobody in are deleted once they are older than
--keep-empty-min (vision/empty_frames.py). Every frame with a person in it,
and every frame it skipped or could not decode, stays for the retention purge.

Usage:
  python scripts/read_queue.py --queue /mnt/ssd/frames
  python scripts/read_queue.py --queue /mnt/ssd/frames --max-fps 2
"""
import argparse
import os
import signal
import sys
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.clock import clock_synced  # noqa: E402
from vision.empty_frames import EmptyFrameSweeper  # noqa: E402
from vision.measure import load_frame  # noqa: E402
from vision.people import detect_people  # noqa: E402
from vision.pipeline import Sighting, locate_claims, resolve_bib_claims  # noqa: E402
from vision.queue import FrameQueue  # noqa: E402
from vision.recognize import read_bib  # noqa: E402
from vision.report import (  # noqa: E402
    SightingLog, health_snapshot, mean_luminance,
)
from vision.track import Tracker  # noqa: E402
import json  # noqa: E402

HEALTH_EVERY_S = 2.0
# How often frames proven empty are deleted. Deleting is cheap; this only
# keeps the reader from listing the ledger on every frame.
SWEEP_EVERY_S = 30.0
# Empty frames are kept this long, so a runner the person detector missed
# entirely can still be looked at right after it happened.
DEFAULT_KEEP_EMPTY_MIN = 10.0
IDLE_SLEEP_S = 0.25
# Crops are kept until their track closes. A track can start long before its
# best frame ages out, so the cache is generous; a bib crop is a few KB.
CROP_CACHE_FRAMES = 900


def read_frame_with_crops(image):
    """read_frame, but it also hands back the deskewed crop per sighting.

    pipeline.read_frame throws the crops away because the measurement script
    only needs numbers. The audit screen needs the picture that produced the
    number, so this keeps them. The detection logic is identical and is
    reused rather than copied.
    """
    claims, crops = locate_claims(image, detect_people(image))

    out = []
    for person_box, bib_box in resolve_bib_claims(claims):
        if bib_box is None:
            out.append((Sighting(None, 0.0, None, person_box), None))
            continue
        crop = crops[tuple(bib_box)]
        text, confidence = read_bib(crop)
        out.append((Sighting(text, confidence, bib_box, person_box), crop))
    return out


class Session:
    def __init__(self, queue_dir, max_fps, max_lag_s=0.0, workers=1,
                 keep_empty_s=DEFAULT_KEEP_EMPTY_MIN * 60):
        self.queue = FrameQueue(queue_dir)
        self.dir = Path(queue_dir)
        self.crops_dir = self.dir / "crops"
        self.crops_dir.mkdir(exist_ok=True)
        self.log = SightingLog(self.dir / "sightings.jsonl")
        self.health_path = self.dir / "health.json"
        self.tracker = Tracker()
        self.offset = self.queue.session_offset()
        self.min_interval = 1.0 / max_fps if max_fps > 0 else 0.0
        self.max_lag_ns = int(max_lag_s * 1e9) if max_lag_s > 0 else 0
        self.skipped = 0
        self.done_times = deque(maxlen=30)
        self.sweeper = EmptyFrameSweeper(queue_dir, keep_empty_s)

        self.frame_index = 0
        self.stamps = {}
        self.crops = {}
        self.order = deque()
        self.processed = 0
        self.torn = 0
        self.durations = deque(maxlen=50)
        self.luminance = 0.0
        self.recent_stamps = deque(maxlen=30)

        # Frames are read on several threads at once and committed in order.
        # Read one at a time, the reader used one of the Pi's four cores and
        # stayed at 5 frames a second with the CPU 86 percent idle, so the
        # camera at 5 fps left it no headroom and anybody in frame built a
        # backlog. Detection, OpenCV and onnxruntime all release the GIL.
        self.workers = max(1, int(workers))
        self.pool = ThreadPoolExecutor(self.workers) if self.workers > 1 else None
        self.inflight = deque()     # (path, frame index, future), oldest first

    # ── per-frame ────────────────────────────────────────────────────────

    def _read(self, path):
        """The expensive part, safe to run on a worker thread."""
        started = time.monotonic()
        image = load_frame(path)
        pairs = None if image is None else read_frame_with_crops(image)
        return image, pairs, (time.monotonic() - started) * 1000.0

    def submit(self, path):
        """Start reading a frame. Its index is fixed now, in queue order."""
        index = self.frame_index
        self.frame_index += 1
        if self.pool is not None:
            future = self.pool.submit(self._read, path)
        else:
            future = Future()
            future.set_result(self._read(path))
        self.inflight.append((path, index, future))

    def commit_oldest(self):
        """Hand the oldest frame in flight to the tracker, waiting if needed."""
        path, index, future = self.inflight.popleft()
        self.commit(path, index, *future.result())

    def process(self, path):
        """Read one frame and commit it. Kept for callers outside the loop."""
        self.submit(path)
        self.commit_oldest()

    def commit(self, path, index, image, pairs, duration_ms):
        if self.offset is None:
            # Started as a service beside capture, the reader can come up
            # before capture has written session.json. Read once at start,
            # the offset stayed missing for the whole run and no sighting
            # could be tied to a gun time.
            self.offset = self.queue.session_offset()
        if image is None:
            # Writes are atomic against a killed process but never fsynced,
            # so a power cut can land the rename before the data. One bad
            # frame must not stop the session.
            self.torn += 1
            self.queue.mark_done(path)
            return
        stamp = self.queue.timestamp_of(path)

        self.tracker.add(index, [s for s, _ in pairs])

        self.stamps[index] = stamp
        self.crops[index] = {
            tuple(s.bib_box): c for s, c in pairs if s.bib_box is not None
        }
        self.order.append(index)
        self._prune()

        self.luminance = mean_luminance(image)
        self.recent_stamps.append(stamp)
        self.processed += 1
        self.done_times.append(time.monotonic())
        # Wall time per frame: with several frames in flight each one takes
        # longer than the reader spends on it.
        self.durations.append(duration_ms / self.workers)
        self.queue.mark_done(path)
        # Only after the move: the ledger names files in done/.
        self.sweeper.observe(index, Path(path).name, bool(pairs))

        self.emit(self.tracker.pop_closed(index))

    def _prune(self):
        while len(self.order) > CROP_CACHE_FRAMES:
            old = self.order.popleft()
            self.crops.pop(old, None)
            self.stamps.pop(old, None)

    # ── emitting ─────────────────────────────────────────────────────────

    def emit(self, closed):
        from vision.report import sighting_record

        for result in closed:
            frame_ts = [int(self.stamps[i]) for i in result.frame_indices
                        if i in self.stamps]
            if result.best_frame_index < 0:
                # Nobody in this track was ever read, so there is no best
                # frame. It still counts: somebody crossed and could not be
                # read, which is the lead an operator needs. Timestamp it
                # from the first frame it was seen in.
                stamp = frame_ts[0] if frame_ts else None
                if stamp is None:
                    continue
                record = {
                    "bib_number": None, "confidence": 0.0,
                    "frame_count": int(result.frame_count),
                    "best_frame_ts": int(stamp),
                    "sighted_at": self._iso(stamp), "votes": {},
                }
            else:
                try:
                    record = sighting_record(result, self.stamps, self.offset or 0.0)
                except ValueError:
                    continue
            record["crop"] = self._write_crop(result)
            record["frame_ts"] = frame_ts
            self.log.append(record)

    def _iso(self, stamp):
        from vision.clock import monotonic_to_utc
        return monotonic_to_utc(stamp, self.offset or 0.0).isoformat()

    def _write_crop(self, result):
        """Save the bib that produced the number, and only the bib.

        The crop holds digits and nothing else. It is what the audit screen
        shows beside each row, so a person can tell a correct read from a
        confident wrong one at a glance without opening a full frame of
        somebody's face.
        """
        if result.best_bib_box is None:
            return None
        crop = self.crops.get(result.best_frame_index, {}).get(
            tuple(result.best_bib_box)
        )
        if crop is None:
            return None
        stamp = self.stamps.get(result.best_frame_index)
        name = f"{stamp}.jpg"
        try:
            crop.save(self.crops_dir / name, format="JPEG", quality=90)
        except Exception:
            return None
        return name

    # ── health ───────────────────────────────────────────────────────────

    def skip_stale(self, pending):
        """Drop frames further behind the newest than the lag limit allows.

        The audit view is only worth anything live. A reader slower than the
        camera fell four minutes behind in ten, so past the limit the oldest
        frames are moved to done/ unread. They stay on disk for a later pass.
        Returns the frames still to read.
        """
        if not self.max_lag_ns or len(pending) < 2:
            return pending
        cutoff = self.queue.timestamp_of(pending[-1]) - self.max_lag_ns
        keep = 0
        while keep < len(pending) and self.queue.timestamp_of(pending[keep]) < cutoff:
            keep += 1
        for path in pending[:keep]:
            self.recent_stamps.append(self.queue.timestamp_of(path))
            self.queue.mark_done(path)
        # Advance the frame index across the gap, so a track that spanned it
        # ages out instead of being joined to whoever is in frame now.
        self.frame_index += keep
        self.skipped += keep
        return pending[keep:]

    def reader_fps(self):
        """Frames actually read per second, measured, not the capacity."""
        if len(self.done_times) < 2:
            return 0.0
        span = self.done_times[-1] - self.done_times[0]
        return (len(self.done_times) - 1) / span if span > 0 else 0.0

    def lag_s(self, pending):
        if len(pending) < 2:
            return 0.0
        return (self.queue.timestamp_of(pending[-1])
                - self.queue.timestamp_of(pending[0])) / 1e9

    def capture_fps(self):
        """Measured from the sensor timestamps, not assumed from a flag."""
        if len(self.recent_stamps) < 2:
            return 0.0
        span_ns = self.recent_stamps[-1] - self.recent_stamps[0]
        if span_ns <= 0:
            return 0.0
        return (len(self.recent_stamps) - 1) / (span_ns / 1e9)

    def last_frame_age(self):
        newest = None
        for path in self.dir.glob("*.jpg"):
            try:
                mtime = path.stat().st_mtime
            except FileNotFoundError:
                continue    # read and moved to done/ between glob and stat
            newest = mtime if newest is None else max(newest, mtime)
        if newest is None:
            return float("inf")
        return max(0.0, time.time() - newest)

    def write_health(self):
        durations = list(self.durations)
        pending = self.queue.pending()
        snap = health_snapshot(
            pending=len(pending),
            processed=self.processed,
            ms_per_frame=sum(durations) / len(durations) if durations else 0.0,
            capture_fps=self.capture_fps(),
            clock_synced=clock_synced(),
            ordering_anomalies=self.queue.ordering_anomalies(),
            torn_frames=self.torn,
            mean_luminance=self.luminance,
            last_frame_age_s=self.last_frame_age(),
            reader_fps=self.reader_fps(),
            skipped=self.skipped,
            lag_s=self.lag_s(pending),
        )
        snap["empty_frames_deleted"] = self.sweeper.deleted
        snap["empty_bytes_deleted"] = self.sweeper.deleted_bytes
        snap["updated_at"] = time.time()
        snap["session_offset"] = self.offset
        exposure = self.queue.exposure() or {}
        snap["camera_gain"] = exposure.get("gain")
        snap["exposure_us"] = exposure.get("exposure_us")
        snap["exposure_at_limit"] = exposure.get("at_limit")
        tmp = self.health_path.with_suffix(".json.part")
        tmp.write_text(json.dumps(snap))
        tmp.replace(self.health_path)   # atomic, so a reader never sees half

    # ── the loop ─────────────────────────────────────────────────────────

    def run(self, stop):
        last_health = 0.0
        last_sweep = time.monotonic()
        while not stop():
            busy = {path for path, _, _ in self.inflight}
            pending = self.skip_stale(
                [p for p in self.queue.pending() if p not in busy]
            )
            for path in pending[:self.workers - len(self.inflight)]:
                self.submit(path)
            if self.inflight:
                started = time.monotonic()
                self.commit_oldest()
                if self.min_interval:
                    slack = self.min_interval - (time.monotonic() - started)
                    if slack > 0:
                        time.sleep(slack)
            else:
                time.sleep(IDLE_SLEEP_S)
            if time.monotonic() - last_health > HEALTH_EVERY_S:
                self.write_health()
                last_health = time.monotonic()
            if time.monotonic() - last_sweep > SWEEP_EVERY_S:
                self.sweeper.sweep()
                last_sweep = time.monotonic()

        while self.inflight:
            self.commit_oldest()
        if self.pool is not None:
            self.pool.shutdown()
        # The last runner of the day has nobody following them, so their
        # track never ages out on its own.
        self.emit(self.tracker.flush())
        self.sweeper.sweep()
        self.write_health()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True)
    ap.add_argument("--max-fps", type=float, default=10.0,
                    help="throttle, to leave CPU for the timing backend; keep "
                         "it above the capture --fps or the view falls behind")
    ap.add_argument("--max-lag-s", type=float, default=3.0,
                    help="skip frames further behind than this; 0 reads all")
    ap.add_argument("--workers", type=int, default=min(3, os.cpu_count() or 1),
                    help="frames read at once; leave a core for the backend")
    ap.add_argument("--keep-empty-min", type=float,
                    default=float(os.environ.get("VISION_KEEP_EMPTY_MIN",
                                                 DEFAULT_KEEP_EMPTY_MIN)),
                    help="delete frames proven to show nobody once they are "
                         "older than this many minutes (env VISION_KEEP_EMPTY_MIN)")
    args = ap.parse_args()

    session = Session(args.queue, args.max_fps, args.max_lag_s, args.workers,
                      keep_empty_s=args.keep_empty_min * 60)
    if session.offset is None:
        print("warning: no session.json in the queue, timestamps will be "
              "relative to the epoch and cannot be matched to a gun time")

    stopping = False

    def handle(signum, frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, handle)
    signal.signal(signal.SIGTERM, handle)

    print(f"reading {args.queue} at up to {args.max_fps} fps; Ctrl-C to stop")
    session.run(lambda: stopping)
    print(f"\nprocessed {session.processed} frames, skipped {session.skipped}, "
          f"{session.torn} torn, deleted {session.sweeper.deleted} empty")


if __name__ == "__main__":
    main()
