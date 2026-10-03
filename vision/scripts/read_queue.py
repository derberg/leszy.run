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

Usage:
  python scripts/read_queue.py --queue /mnt/ssd/frames
  python scripts/read_queue.py --queue /mnt/ssd/frames --max-fps 2
"""
import argparse
import signal
import sys
import time
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.clock import clock_synced  # noqa: E402
from vision.locate import extract_bib  # noqa: E402
from vision.measure import load_frame  # noqa: E402
from vision.people import detect_people  # noqa: E402
from vision.pipeline import Sighting, resolve_bib_claims  # noqa: E402
from vision.queue import FrameQueue  # noqa: E402
from vision.recognize import read_bib  # noqa: E402
from vision.report import (  # noqa: E402
    SightingLog, health_snapshot, mean_luminance,
)
from vision.track import Tracker  # noqa: E402
import json  # noqa: E402

HEALTH_EVERY_S = 2.0
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
    people = detect_people(image)
    claims, crops = [], {}
    for person_box in people:
        bib_box, crop = extract_bib(image, region=person_box)
        claims.append((person_box, bib_box))
        if bib_box is not None:
            crops[tuple(bib_box)] = crop

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
    def __init__(self, queue_dir, max_fps):
        self.queue = FrameQueue(queue_dir)
        self.dir = Path(queue_dir)
        self.crops_dir = self.dir / "crops"
        self.crops_dir.mkdir(exist_ok=True)
        self.log = SightingLog(self.dir / "sightings.jsonl")
        self.health_path = self.dir / "health.json"
        self.tracker = Tracker()
        self.offset = self.queue.session_offset()
        self.min_interval = 1.0 / max_fps if max_fps > 0 else 0.0

        self.frame_index = 0
        self.stamps = {}
        self.crops = {}
        self.order = deque()
        self.processed = 0
        self.torn = 0
        self.durations = deque(maxlen=50)
        self.luminance = 0.0
        self.recent_stamps = deque(maxlen=30)

    # ── per-frame ────────────────────────────────────────────────────────

    def process(self, path):
        started = time.monotonic()
        image = load_frame(path)
        if image is None:
            # Writes are atomic against a killed process but never fsynced,
            # so a power cut can land the rename before the data. One bad
            # frame must not stop the session.
            self.torn += 1
            self.queue.mark_done(path)
            return
        stamp = self.queue.timestamp_of(path)
        index = self.frame_index
        self.frame_index += 1

        pairs = read_frame_with_crops(image)
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
        self.durations.append((time.monotonic() - started) * 1000.0)
        self.queue.mark_done(path)

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
            if result.best_frame_index < 0:
                # Nobody in this track was ever read, so there is no best
                # frame. It still counts: somebody crossed and could not be
                # read, which is the lead an operator needs. Timestamp it
                # from the first frame it was seen in.
                stamp = self._any_stamp(result)
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
            self.log.append(record)

    def _any_stamp(self, result):
        return self.stamps.get(max(self.stamps)) if self.stamps else None

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

    def capture_fps(self):
        """Measured from the sensor timestamps, not assumed from a flag."""
        if len(self.recent_stamps) < 2:
            return 0.0
        span_ns = self.recent_stamps[-1] - self.recent_stamps[0]
        if span_ns <= 0:
            return 0.0
        return (len(self.recent_stamps) - 1) / (span_ns / 1e9)

    def last_frame_age(self):
        newest = max(
            (p.stat().st_mtime for p in self.dir.glob("*.jpg")), default=None
        )
        if newest is None:
            return float("inf")
        return max(0.0, time.time() - newest)

    def write_health(self):
        durations = list(self.durations)
        snap = health_snapshot(
            pending=len(self.queue.pending()),
            processed=self.processed,
            ms_per_frame=sum(durations) / len(durations) if durations else 0.0,
            capture_fps=self.capture_fps(),
            clock_synced=clock_synced(),
            ordering_anomalies=self.queue.ordering_anomalies(),
            torn_frames=self.torn,
            mean_luminance=self.luminance,
            last_frame_age_s=self.last_frame_age(),
        )
        snap["updated_at"] = time.time()
        snap["session_offset"] = self.offset
        tmp = self.health_path.with_suffix(".json.part")
        tmp.write_text(json.dumps(snap))
        tmp.replace(self.health_path)   # atomic, so a reader never sees half

    # ── the loop ─────────────────────────────────────────────────────────

    def run(self, stop):
        last_health = 0.0
        while not stop():
            pending = self.queue.pending()
            if pending:
                started = time.monotonic()
                self.process(pending[0])
                if self.min_interval:
                    slack = self.min_interval - (time.monotonic() - started)
                    if slack > 0:
                        time.sleep(slack)
            else:
                time.sleep(IDLE_SLEEP_S)
            if time.monotonic() - last_health > HEALTH_EVERY_S:
                self.write_health()
                last_health = time.monotonic()

        # The last runner of the day has nobody following them, so their
        # track never ages out on its own.
        self.emit(self.tracker.flush())
        self.write_health()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True)
    ap.add_argument("--max-fps", type=float, default=3.0,
                    help="throttle; the Pi cannot read every frame in real time")
    args = ap.parse_args()

    session = Session(args.queue, args.max_fps)
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
    print(f"\nprocessed {session.processed} frames, {session.torn} torn")


if __name__ == "__main__":
    main()
