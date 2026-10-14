"""Deleting the frames that are proven to show nobody.

A frame is about 330 KB and capture writes five a second, so a day of an
empty gate fills the SD card the database lives on. Only a frame the reader
read and found no person in may go, and only once it is old. Everything
below is a way that rule could delete a frame somebody needs.
"""
import os
import time

from vision.empty_frames import EmptyFrameSweeper, LEDGER_NAME
from vision.track import MAX_GAP_FRAMES


def name(i):
    return f"{1_000_000_000 + i * 100_000_000:020d}.jpg"


def put(done, i, age_s=3600.0, size=100):
    path = done / name(i)
    path.write_bytes(b"x" * size)
    old = time.time() - age_s
    os.utime(path, (old, old))
    return path


def make(tmp_path, keep_s=600.0):
    done = tmp_path / "done"
    done.mkdir(exist_ok=True)
    return done, EmptyFrameSweeper(tmp_path, keep_s)


def observe_all(sweeper, people):
    """people[i] says whether frame i had somebody in it."""
    for i, had in enumerate(people):
        sweeper.observe(i, name(i), had)


def test_an_old_empty_frame_is_deleted_and_counted(tmp_path):
    done, sweeper = make(tmp_path)
    count = 2 * MAX_GAP_FRAMES + 3
    for i in range(count):
        put(done, i, size=100)
    observe_all(sweeper, [False] * count)
    sweeper.sweep()
    # The newest MAX_GAP_FRAMES frames are still candidates: a person in the
    # next frame would make them part of the approach.
    survivors = sorted(p.name for p in done.glob("*.jpg"))
    assert survivors == [name(i) for i in range(count - MAX_GAP_FRAMES, count)]
    assert sweeper.deleted == count - MAX_GAP_FRAMES
    assert sweeper.deleted_bytes == 100 * (count - MAX_GAP_FRAMES)


def test_a_frame_with_a_person_is_never_deleted(tmp_path):
    # Whether or not the track has closed yet: a person frame never enters
    # the ledger, so no ordering of close and sweep can remove it.
    done, sweeper = make(tmp_path, keep_s=0)
    people = [False] * 20 + [True] + [False] * 20
    for i in range(len(people)):
        put(done, i)
    observe_all(sweeper, people)
    sweeper.sweep()
    assert (done / name(20)).exists()


def test_empty_frames_beside_a_person_are_kept(tmp_path):
    # The detector misses a runner in a frame or two mid-pass. Those frames
    # sit inside the pass, so they are not proof the gate was empty.
    done, sweeper = make(tmp_path, keep_s=0)
    people = [False] * 20 + [True, False, False, True] + [False] * 20
    for i in range(len(people)):
        put(done, i)
    observe_all(sweeper, people)
    sweeper.sweep()
    kept = {p.name for p in done.glob("*.jpg")}
    for i in range(20 - MAX_GAP_FRAMES, 23 + MAX_GAP_FRAMES + 1):
        assert name(i) in kept, i
    assert name(20 - MAX_GAP_FRAMES - 1) not in kept
    assert name(23 + MAX_GAP_FRAMES + 1) not in kept


def test_a_recent_empty_frame_is_kept_for_the_window(tmp_path):
    # A runner the detector missed entirely is still there to look at for
    # ten minutes after the fact.
    done, sweeper = make(tmp_path, keep_s=600)
    count = 3 * MAX_GAP_FRAMES
    for i in range(count):
        put(done, i, age_s=60)
    observe_all(sweeper, [False] * count)
    sweeper.sweep()
    assert len(list(done.glob("*.jpg"))) == count
    assert sweeper.deleted == 0


def test_a_kept_frame_goes_once_it_ages_past_the_window(tmp_path):
    done, sweeper = make(tmp_path, keep_s=600)
    count = 3 * MAX_GAP_FRAMES
    paths = [put(done, i, age_s=60) for i in range(count)]
    observe_all(sweeper, [False] * count)
    sweeper.sweep()
    old = time.time() - 601
    for p in paths:
        os.utime(p, (old, old))
    sweeper.sweep()
    assert sweeper.deleted == count - MAX_GAP_FRAMES


def test_a_frame_the_reader_never_judged_is_left_alone(tmp_path):
    # A frame skipped for lag, or a torn one, was never checked for people.
    done, sweeper = make(tmp_path, keep_s=0)
    stray = put(done, 999)
    count = 3 * MAX_GAP_FRAMES
    for i in range(count):
        put(done, i)
    observe_all(sweeper, [False] * count)
    sweeper.sweep()
    assert stray.exists()


def test_the_ledger_survives_a_restart(tmp_path):
    # Frames judged empty by a reader that then restarted must still go,
    # and nothing it did not judge may.
    done, first = make(tmp_path, keep_s=600)
    count = 3 * MAX_GAP_FRAMES
    paths = [put(done, i, age_s=60) for i in range(count)]
    observe_all(first, [False] * count)
    first.sweep()
    assert (tmp_path / LEDGER_NAME).exists()

    old = time.time() - 601
    for p in paths:
        os.utime(p, (old, old))
    second = EmptyFrameSweeper(tmp_path, 600)
    second.sweep()
    assert second.deleted == count - MAX_GAP_FRAMES


def test_a_ledger_entry_whose_file_is_gone_is_dropped(tmp_path):
    # A crash after the unlink and before the ledger rewrite leaves the name
    # behind. The next sweep forgets it rather than failing on it.
    done, sweeper = make(tmp_path, keep_s=0)
    (tmp_path / LEDGER_NAME).write_text(name(1) + "\n")
    sweeper.sweep()
    assert (tmp_path / LEDGER_NAME).read_text() == ""
    assert sweeper.deleted == 0


def test_a_ledger_line_that_is_not_a_frame_name_is_never_followed(tmp_path):
    # The ledger names files to delete. Anything that is not a bare frame
    # name in done/ is ignored, so a damaged line cannot reach another file.
    done, sweeper = make(tmp_path, keep_s=0)
    victim = tmp_path / "sightings.jsonl"
    victim.write_text("{}\n")
    (tmp_path / LEDGER_NAME).write_text("../sightings.jsonl\nsightings.jsonl\n\n")
    sweeper.sweep()
    assert victim.exists()
