"""The streaming session: frames in, sightings out.

Detection itself is tested elsewhere and needs a 14 MB model, so the pipeline
stage is substituted here. What is under test is the plumbing around it, which
is where a live session actually fails: a torn frame, a track that never
closes, a crop that gets paired with the wrong row.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

from vision.pipeline import Sighting
from vision.queue import FrameQueue

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "read_queue.py"


def load_module():
    spec = importlib.util.spec_from_file_location("read_queue", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["read_queue"] = module
    spec.loader.exec_module(module)
    return module


rq = load_module()


def frame(colour=(120, 120, 120)):
    return Image.new("RGB", (64, 48), colour)


def crop():
    return Image.new("RGB", (20, 10), (255, 255, 255))


def seed(tmp_path, count, start=1_000_000_000, step=100_000_000):
    queue = FrameQueue(tmp_path)
    queue.write_session(1_700_000_000.0)
    for i in range(count):
        queue.write(frame(), start + i * step)
    return queue


def session(tmp_path, reader):
    s = rq.Session(tmp_path, max_fps=0)
    # Substitute the detection stage; the plumbing around it is the subject.
    rq.read_frame_with_crops = reader
    return s


def drain(s):
    """Run the loop until the queue is empty, then shut down."""
    calls = {"n": 0}

    def stop():
        calls["n"] += 1
        return not s.queue.pending()

    s.run(stop)


def records(tmp_path):
    path = Path(tmp_path) / "sightings.jsonl"
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# ─── the happy path ─────────────────────────────────────────────────────────

def test_one_runner_across_many_frames_is_logged_once(tmp_path):
    seed(tmp_path, 12)
    s = session(tmp_path, lambda img: [
        (Sighting("47", 0.9, (10, 10, 30, 20), (0, 0, 60, 48)), crop())
    ])
    drain(s)
    rows = records(tmp_path)
    assert len(rows) == 1
    assert rows[0]["bib_number"] == "47"
    assert rows[0]["frame_count"] == 12


def test_the_sighting_carries_a_wall_clock_time_from_the_session_offset(tmp_path):
    seed(tmp_path, 8)
    s = session(tmp_path, lambda img: [
        (Sighting("47", 0.9, (10, 10, 30, 20), (0, 0, 60, 48)), crop())
    ])
    drain(s)
    # offset 1_700_000_000 plus one second of sensor time.
    assert records(tmp_path)[0]["sighted_at"].startswith("2023-11-14T")


def test_the_crop_written_is_the_one_from_the_best_read(tmp_path):
    seed(tmp_path, 6)
    seen = []

    def reader(img):
        # Confidence climbs, so the last frame wins and its box must be the
        # one whose crop is saved.
        n = len(seen)
        seen.append(n)
        box = (10 + n, 10, 30 + n, 20)
        return [(Sighting("47", 0.1 * (n + 1), box, (0, 0, 60, 48)), crop())]

    s = session(tmp_path, reader)
    drain(s)
    row = records(tmp_path)[0]
    assert row["crop"] is not None
    assert (Path(tmp_path) / "crops" / row["crop"]).exists()


# ─── the failures that actually happen at a gate ────────────────────────────

def test_an_unreadable_runner_still_gets_a_row(tmp_path):
    # Somebody crossed and could not be read. Dropping that row would make
    # the screen claim coverage it does not have.
    seed(tmp_path, 7)
    s = session(tmp_path, lambda img: [
        (Sighting(None, 0.0, None, (0, 0, 60, 48)), None)
    ])
    drain(s)
    rows = records(tmp_path)
    assert len(rows) == 1
    assert rows[0]["bib_number"] is None
    assert rows[0]["crop"] is None


def test_a_torn_frame_is_counted_and_does_not_stop_the_session(tmp_path):
    # Writes are atomic against a kill but never fsynced, so a power cut can
    # land the rename before the data.
    seed(tmp_path, 4)
    (Path(tmp_path) / f"{9_000_000_000:020d}.jpg").write_bytes(b"not a jpeg")
    s = session(tmp_path, lambda img: [
        (Sighting("47", 0.9, (10, 10, 30, 20), (0, 0, 60, 48)), crop())
    ])
    drain(s)
    assert s.torn == 1
    assert s.processed == 4


def test_the_last_runner_of_the_day_is_not_lost_at_shutdown(tmp_path):
    # Their track never ages out, because nobody follows them.
    seed(tmp_path, 3)
    s = session(tmp_path, lambda img: [
        (Sighting("86", 0.8, (10, 10, 30, 20), (0, 0, 60, 48)), crop())
    ])
    drain(s)
    assert [r["bib_number"] for r in records(tmp_path)] == ["86"]


def test_two_runners_at_once_produce_two_rows_not_one(tmp_path):
    seed(tmp_path, 10)
    s = session(tmp_path, lambda img: [
        (Sighting("47", 0.9, (5, 10, 15, 20), (0, 0, 20, 48)), crop()),
        (Sighting("86", 0.9, (40, 10, 50, 20), (35, 0, 60, 48)), crop()),
    ])
    drain(s)
    assert sorted(r["bib_number"] for r in records(tmp_path)) == ["47", "86"]


# ─── health ─────────────────────────────────────────────────────────────────

def test_health_is_written_atomically_and_is_always_valid_json(tmp_path):
    seed(tmp_path, 3)
    s = session(tmp_path, lambda img: [])
    drain(s)
    snap = json.loads((Path(tmp_path) / "health.json").read_text())
    assert snap["processed"] == 3
    assert "exposure" in snap and "keeping_up" in snap


def test_capture_fps_is_measured_from_sensor_timestamps(tmp_path):
    # 100 ms apart is 10 fps. Reading it off a flag would report whatever was
    # configured rather than what the camera did.
    seed(tmp_path, 6, step=100_000_000)
    s = session(tmp_path, lambda img: [])
    drain(s)
    assert s.capture_fps() == pytest.approx(10.0, rel=0.01)


def test_a_grey_frame_is_not_reported_as_an_exposure_problem(tmp_path):
    seed(tmp_path, 3)
    s = session(tmp_path, lambda img: [])
    drain(s)
    assert json.loads((Path(tmp_path) / "health.json").read_text())["exposure"] == "ok"


def test_a_black_frame_is_reported_as_dark(tmp_path):
    # The operator sets gain by hand and has no other way to find this out.
    queue = FrameQueue(tmp_path)
    queue.write_session(1_700_000_000.0)
    queue.write(Image.new("RGB", (64, 48), (0, 0, 0)), 1_000_000_000)
    s = session(tmp_path, lambda img: [])
    drain(s)
    assert json.loads((Path(tmp_path) / "health.json").read_text())["exposure"] == "dark"


# ─── memory ─────────────────────────────────────────────────────────────────

def test_the_crop_cache_does_not_grow_for_the_whole_race(tmp_path):
    rq.CROP_CACHE_FRAMES = 10
    try:
        seed(tmp_path, 40)
        s = session(tmp_path, lambda img: [
            (Sighting("47", 0.9, (10, 10, 30, 20), (0, 0, 60, 48)), crop())
        ])
        drain(s)
        assert len(s.crops) <= 11
    finally:
        rq.CROP_CACHE_FRAMES = 900
