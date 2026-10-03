"""The record a session writes for the audit tab.

Everything here is a pure function over plain data, because the audit tab is
read by a person deciding whether the camera is working, and a wrong answer
there sends somebody to fix the wrong thing.
"""
import json

import pytest
from PIL import Image

from vision.clock import monotonic_to_utc
from vision.report import (
    SightingLog,
    frames_per_track_histogram,
    health_snapshot,
    mean_luminance,
    recognition_rate,
    sighting_record,
)
from vision.track import TrackResult


def track(text="47", confidence=0.9, frame_count=12, best=5, votes=None):
    return TrackResult(
        text=text,
        confidence=confidence,
        frame_count=frame_count,
        best_frame_index=best,
        votes=votes if votes is not None else {"47": 10.8},
    )


# ─── sighting_record ────────────────────────────────────────────────────────

def test_the_sighting_is_timestamped_from_its_best_frame_not_from_now():
    # The crossing moment is when the runner was best seen, not when the
    # reader got round to reading them. The reader is allowed to fall behind
    # by design, so write time means nothing.
    stamps = {5: 1_000_000_000, 9: 9_000_000_000}
    record = sighting_record(track(best=5), stamps, offset=1_700_000_000.0)
    assert record["sighted_at"] == monotonic_to_utc(1_000_000_000, 1_700_000_000.0).isoformat()


def test_an_unreadable_track_still_produces_a_record():
    # Somebody crossed and could not be read. That row is the lead an
    # operator needs when a runner is missing, so it must survive.
    record = sighting_record(
        track(text=None, confidence=0.0, votes={}), {5: 1}, offset=0.0
    )
    assert record["bib_number"] is None
    assert record["frame_count"] == 12


def test_a_track_whose_best_frame_is_unknown_is_not_silently_timestamped():
    # best_frame_index is -1 when no sighting in the track ever carried a
    # number. Inventing a timestamp for it would put a fabricated crossing
    # time in the record.
    with pytest.raises(ValueError):
        sighting_record(track(best=-1), {5: 1}, offset=0.0)


# ─── the log file ───────────────────────────────────────────────────────────

def test_each_sighting_is_one_line_so_a_reader_can_resume_mid_file(tmp_path):
    log = SightingLog(tmp_path / "sightings.jsonl")
    log.append({"bib_number": "47"})
    log.append({"bib_number": None})
    lines = (tmp_path / "sightings.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["bib_number"] == "47"


def test_a_record_never_contains_a_newline_that_would_split_it(tmp_path):
    # A stray newline inside a value would make one sighting look like two,
    # and the second half would parse as a sighting with no bib.
    log = SightingLog(tmp_path / "sightings.jsonl")
    log.append({"note": "two\nlines"})
    assert len((tmp_path / "sightings.jsonl").read_text().splitlines()) == 1


# ─── health ─────────────────────────────────────────────────────────────────

def test_health_reports_a_backlog_that_is_growing():
    snap = health_snapshot(
        pending=120, processed=50, ms_per_frame=400.0, capture_fps=10.0,
        clock_synced=True, ordering_anomalies=[], torn_frames=0,
        mean_luminance=0.4, last_frame_age_s=0.2,
    )
    # 400 ms/frame is 2.5 frames/s against 10 captured. It cannot catch up.
    assert snap["keeping_up"] is False


def test_health_says_the_camera_is_gone_when_no_frame_has_landed():
    snap = health_snapshot(
        pending=0, processed=500, ms_per_frame=50.0, capture_fps=10.0,
        clock_synced=True, ordering_anomalies=[], torn_frames=0,
        mean_luminance=0.4, last_frame_age_s=30.0,
    )
    assert snap["capture_alive"] is False


def test_an_unsynced_clock_is_reported_rather_than_ignored():
    snap = health_snapshot(
        pending=0, processed=1, ms_per_frame=50.0, capture_fps=10.0,
        clock_synced=False, ordering_anomalies=[], torn_frames=0,
        mean_luminance=0.4, last_frame_age_s=0.1,
    )
    assert snap["clock_synced"] is False


def test_exposure_is_flagged_dark_and_bright_separately():
    # AeEnable is False and gain does not adapt, so the operator sets it by
    # hand. Dark and bright need different corrections.
    dark = health_snapshot(
        pending=0, processed=1, ms_per_frame=50.0, capture_fps=10.0,
        clock_synced=True, ordering_anomalies=[], torn_frames=0,
        mean_luminance=0.03, last_frame_age_s=0.1,
    )
    bright = health_snapshot(
        pending=0, processed=1, ms_per_frame=50.0, capture_fps=10.0,
        clock_synced=True, ordering_anomalies=[], torn_frames=0,
        mean_luminance=0.97, last_frame_age_s=0.1,
    )
    assert dark["exposure"] == "dark"
    assert bright["exposure"] == "bright"


def test_mean_luminance_is_normalised_so_a_threshold_means_one_thing():
    assert mean_luminance(Image.new("RGB", (4, 4), (0, 0, 0))) == 0.0
    assert mean_luminance(Image.new("RGB", (4, 4), (255, 255, 255))) == 1.0


# ─── stats ──────────────────────────────────────────────────────────────────

def test_recognition_rate_counts_unreadable_tracks_in_the_denominator():
    # Dropping them would report a camera that reads one runner in ten as
    # perfect.
    assert recognition_rate([track(), track(text=None), track(), track()]) == 0.75


def test_recognition_rate_of_nothing_is_not_a_division_by_zero():
    assert recognition_rate([]) == 0.0


def test_frames_per_track_histogram_separates_a_good_gate_from_a_bad_one():
    # The spec's geometry argument: ~30 frames means the camera points down
    # the lane, a cluster at 4 means it points across it.
    hist = frames_per_track_histogram([track(frame_count=n) for n in (2, 4, 30, 31)])
    assert hist["1-4"] == 2
    assert hist["25+"] == 2
