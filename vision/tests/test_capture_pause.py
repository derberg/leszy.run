import json

import numpy as np
import pytest

import vision.capture as capture


def _set(queue_dir, recording):
    (queue_dir / "recording.json").write_text(json.dumps({"recording": recording}))


def test_recording_is_on_when_no_switch_file_exists(tmp_path):
    assert capture.recording_enabled(tmp_path)


def test_the_switch_file_pauses_recording(tmp_path):
    _set(tmp_path, False)
    assert not capture.recording_enabled(tmp_path)


def test_an_unreadable_switch_file_records(tmp_path):
    # A paused camera at a race records nobody. A broken file must not do that.
    (tmp_path / "recording.json").write_text("{not json")
    assert capture.recording_enabled(tmp_path)
    (tmp_path / "recording.json").write_text(json.dumps({"recording": "no"}))
    assert capture.recording_enabled(tmp_path)


class _Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_the_switch_is_read_at_most_once_a_second(tmp_path):
    clock = _Clock()
    switch = capture.RecordSwitch(tmp_path, clock=clock)
    assert switch.recording()
    _set(tmp_path, False)
    clock.now = 0.5
    assert switch.recording()
    clock.now = 1.0
    assert not switch.recording()


def test_a_resume_takes_effect_within_a_second(tmp_path):
    clock = _Clock()
    _set(tmp_path, False)
    switch = capture.RecordSwitch(tmp_path, clock=clock)
    assert not switch.recording()
    _set(tmp_path, True)
    clock.now = 1.0
    assert switch.recording()


def test_the_switch_logs_each_change(tmp_path, capsys):
    clock = _Clock()
    switch = capture.RecordSwitch(tmp_path, clock=clock)
    switch.recording()
    _set(tmp_path, False)
    clock.now = 1.0
    switch.recording()
    _set(tmp_path, True)
    clock.now = 2.0
    switch.recording()
    out = capsys.readouterr().out
    assert "recording paused" in out
    assert "recording resumed" in out


class _Request:
    def __init__(self, array, ts):
        self.array, self.ts = array, ts

    def make_array(self, _):
        return self.array

    def get_metadata(self):
        return {"SensorTimestamp": self.ts}

    def release(self):
        pass


class _DarkCamera:
    """Delivers `frames` dark frames, then stalls."""

    camera_controls = {"AnalogueGain": (1.0, 16.0)}

    def __init__(self, frames):
        self.left = frames
        self.controls = []

    def start(self): pass
    def stop(self): pass
    def close(self): pass

    def set_controls(self, controls):
        self.controls.append(controls)

    def capture_request(self, wait=None):
        if self.left == 0:
            raise TimeoutError
        self.left -= 1
        return _Request(np.full((40, 60, 3), 10, dtype=np.uint8), 1000 - self.left)


def _run(tmp_path, monkeypatch, frames=12):
    camera = _DarkCamera(frames)
    monkeypatch.setattr(capture, "clock_synced", lambda: True)
    monkeypatch.setattr(capture, "open_camera", lambda **_: camera)
    with pytest.raises(capture.CameraStalled):
        capture.run_capture(tmp_path, 60)
    return camera, sorted(tmp_path.glob("*.jpg"))


def test_a_recording_camera_writes_its_frames(tmp_path, monkeypatch):
    _, written = _run(tmp_path, monkeypatch)
    assert len(written) == 12


def test_a_paused_camera_writes_nothing_and_keeps_adapting_exposure(tmp_path, monkeypatch):
    # The light changes in the hour before the first runner. A camera that
    # stopped adapting while paused would resume at the wrong exposure.
    _set(tmp_path, False)
    camera, written = _run(tmp_path, monkeypatch)
    assert written == []
    assert camera.controls, "exposure was not adapted while paused"
